/**
 * Guards permission-marked writes on owner-scoped tables.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * For a verified non-admin agent, an HTTP write to a table listed in
 * resources/record-owner-guard.ts's OWNER_FIELDS, through a resource class that
 * extends that table:
 *   - addressed to one record (POST/PUT/PATCH/DELETE to `/<Table>/<id>`) is
 *     checked on POST/PUT/PATCH for a body `id` that names a record other than
 *     the addressed one (`bodyIdRefusal`: `writeIdNotAddressedRefusal`, 403,
 *     for a string or number id; `idTargetMismatchRefusal`, 400, for a present,
 *     non-null id of any other type; an absent or null id passes), then for a stored owner other than
 *     the caller (`ownerMutationRefusal`, 403), if reached. The middleware can
 *     return the owner refusal first on a plain addressed URL;
 *   - addressed to no single record (the table's collection, with or without a
 *     query): if reached, the table guard returns `collectionWriteRefusal` (403)
 *     on PUT, PATCH and DELETE; existing DELETE middleware may refuse earlier.
 *     A POST to a collection is NOT decided here: it is delegated to the
 *     resource's own POST handling (its create and attribution rules;
 *     OrgEvent's post() can also update a caller-owned record its body names).
 * A write refused by this guard leaves its target row unchanged
 * (authentication has already recorded the request's replay nonce), and one
 * such refusal fails the whole request. When the guard's own stored-record
 * read for an addressed owner check fails, the request is refused with
 * `owner_check_unavailable`.
 *
 * This guard exempts administrators, trusted internal calls and anonymous
 * callers. Write targets with a non-null, non-false `checkPermission` take
 * the asynchronous guard path, including permission-marked internal calls.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * For an addressed REST call, Harper supplies the target resolved to a record
 * id and the request as context to static `getResource(target, context, options)`.
 * A collection target addresses no single record and carries `isCollection: true`.
 * Internal or MQTT calls supply a context, not an HTTP request.
 * `guardOwnerScopedWrites` gives every owner-scoped table class its own static
 * `getResource` that applies the rule there and then delegates to the inherited
 * one. A resource class that extends the flair table inherits it; a custom
 * resource that extends `Resource` rather than the table (for example
 * AgentReadPosition) is not on this path and enforces its own rule. The table
 * list is OWNER_FIELDS; test/unit/record-owner-guard-coverage.test.ts fails
 * when a table declares an owner-shaped column and is neither added to that map
 * nor exempted with a stated reason, so a new owner-scoped table has to be
 * enrolled there. resources/owner-scoped-writes.ts installs the guard at load
 * and logs any OWNER_FIELDS table it could not guard.
 *
 * This module imports only helpers from resources/record-owner-guard.ts, which
 * has no Harper or authentication-module dependency, so it is unit-tested
 * directly (test/unit/owner-scoped-write-policy.test.ts);
 * the dependencies it needs are passed in by resources/owner-scoped-writes.ts.
 * test/integration/owner-scoped-writes.test.ts checks the rule on a real Harper.
 *
 */
import { collectionWriteRefusal, isForbiddenOwnerMutation, ownerMutationRefusal } from "./record-owner-guard.js";

/** The caller verdict the guard decides on (resources/agent-auth.ts's AgentAuthVerdict). */
export type WriteCaller =
  | { kind: "internal" }
  | { kind: "agent"; agentId: string; isAdmin: boolean }
  | { kind: "anonymous" };

export interface OwnerScopedWriteDeps {
  /** Resolves a request context to a caller verdict (resolveAgentAuth). */
  resolveAuth: (context: unknown) => Promise<WriteCaller>;
  /** Reads the stored record `id` of `table`, outside the request's transaction. */
  readStored: (table: string, id: unknown) => unknown;
  /** The refusal when the stored record cannot be read (ownerCheckUnavailable). */
  unreadable: (err: unknown) => Response;
  /** Reads body data from the entry call's context. */
  readBody: (context: unknown) => unknown;
  /**
   * An optional table-specific refusal run before this guard's collection and
   * ownership branches. It lets a table refuse a write shape that this guard
   * would otherwise refuse for a different reason (for example a reserved
   * record in a collection write).
   */
  refuseReservedWrite?: (
    table: string,
    method: string,
    target: { id?: unknown; isCollection?: unknown },
    context: unknown,
  ) => Promise<Response | null>;
}

/** Marks a table class whose writes have been guarded. */
export const OWNER_SCOPED_WRITE_GUARD: unique symbol = Symbol.for("flair.ownerScopedWriteGuard");

/** The Harper resource methods an HTTP request reaches to write a record. */
export const GUARDED_WRITE_METHODS: readonly string[] = Object.freeze(["put", "patch", "delete", "post"]);

/** Methods refused on a collection target, where the request does not resolve to one addressed row. */
const STORED_RECORD_METHODS: ReadonlySet<string> = new Set(["put", "patch", "delete"]);

/** Methods whose body `id` must name the addressed record. */
const BODY_ID_METHODS: ReadonlySet<string> = new Set(["put", "patch", "post"]);

/**
 * Whether `target` carries a non-null, non-false permission marker.
 */
export function isRequestEntryTarget(target: unknown): boolean {
  if (target == null || typeof target !== "object") return false;
  const permission = (target as { checkPermission?: unknown }).checkPermission;
  return permission != null && permission !== false;
}

/** Whether a resolved target addresses no single record: a collection, or no id at all. */
export function addressesNoSingleRecord(target: { id?: unknown; isCollection?: unknown }): boolean {
  return target.isCollection === true || target.id == null;
}

/** The refusal when the caller of a guarded write cannot be resolved. */
export function unverifiedWriteCallerRefusal(table: string): Error & { statusCode: number } {
  return Object.assign(
    new Error(`the caller of this ${table} write could not be verified, so it was refused; retry`),
    { statusCode: 500 },
  );
}

/** A non-admin addressed write whose body could not be read: refused, never admitted. */
export function writeBodyUnreadableRefusal(table: string): Response {
  return new Response(JSON.stringify({
    error: "write_body_unreadable",
    message: `the ${table} write's body could not be read, so the record it names could not be checked`,
  }), { status: 400, headers: { "Content-Type": "application/json" } });
}

/** The named refusal for an addressed write whose string or number body `id` names a record other than the one it addresses. */
export function writeIdNotAddressedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "write_id_not_addressed",
    message: "a write may name only the record it addresses",
  }), { status: 403, headers: { "Content-Type": "application/json" } });
}

/**
 * The named refusal for an addressed write whose body `id` is present, not
 * null, not a string or number, and not the addressed key. It answers the error and status of
 * resources/originator-instance.ts's body-id check and echoes no submitted value.
 */
export function idTargetMismatchRefusal(): Response {
  return new Response(JSON.stringify({
    error: "id_target_mismatch",
    message: "the request body id does not match the address it was sent to",
  }), { status: 400, headers: { "Content-Type": "application/json" } });
}

function isScalarId(id: unknown): id is string | number {
  return typeof id === "string" || typeof id === "number";
}

/**
 * Whether `id` is the key `targetId` addresses: the same text for a string or
 * number pair, or two arrays whose elements are strictly equal in order.
 */
export function isAddressedKey(targetId: unknown, id: unknown): boolean {
  if (isScalarId(targetId) && isScalarId(id)) return String(id) === String(targetId);
  if (Array.isArray(targetId) && Array.isArray(id)) {
    return targetId.length === id.length && targetId.every((part, i) => part === id[i]);
  }
  return false;
}

/**
 * The refusal for a write addressed to `targetId` whose parsed `body` names a
 * record other than the addressed one, or null. It checks the body when it is
 * an object, and each object element of an array body. A record whose `id` is
 * absent, null or the addressed key passes. Otherwise a string or number `id`
 * at a string or number address gets `writeIdNotAddressedRefusal` (403), and
 * any other `id` gets `idTargetMismatchRefusal` (400).
 */
export function bodyIdRefusal(targetId: unknown, body: unknown): Response | null {
  if (targetId == null || body == null || typeof body !== "object") return null;
  const records: unknown[] = Array.isArray(body) ? body : [body];
  for (const record of records) {
    if (record == null || typeof record !== "object" || Array.isArray(record)) continue;
    const id = (record as { id?: unknown }).id;
    if (id == null || isAddressedKey(targetId, id)) continue;
    return isScalarId(id) && isScalarId(targetId) ? writeIdNotAddressedRefusal() : idTargetMismatchRefusal();
  }
  return null;
}

/**
 * Decide one entry write. Resolves when the write may proceed; rejects with the
 * refusal (a Response, which Harper's REST layer returns as is, or a named
 * error) when it may not.
 *
 * In order: resolve the caller (an unresolvable one is refused); leave an
 * administrator, a trusted internal call and an anonymous caller to their
 * existing handling; refuse a collection PUT/PATCH/DELETE; refuse an addressed
 * POST/PUT/PATCH whose body names a record other than the addressed one
 * (`bodyIdRefusal`); then refuse a write to a stored record owned by another
 * principal. Each refusal by this guard leaves the target row unchanged.
 */
export async function admitOwnerScopedWrite(
  table: string,
  ownerField: string,
  method: string,
  target: { id?: unknown; isCollection?: unknown },
  context: unknown,
  deps: OwnerScopedWriteDeps,
): Promise<void> {
  let caller: WriteCaller;
  try {
    caller = await deps.resolveAuth(context);
  } catch {
    throw unverifiedWriteCallerRefusal(table);
  }
  if (caller.kind !== "agent" || caller.isAdmin === true) return;

  // A table-specific refusal runs before this guard's collection and ownership
  // branches. When this pre-check can identify a reserved record (a proposed
  // body marker or a readable stored row),
  // its named refusal replaces this guard's generic one. A collection delete
  // this pre-check cannot resolve is still refused by the collection branch
  // below. Only callers reaching OrgEvent.delete() run its selection pre-scan.
  const reserved = await deps.refuseReservedWrite?.(table, method, target, context);
  if (reserved) throw reserved;

  if (addressesNoSingleRecord(target)) {
    if (STORED_RECORD_METHODS.has(method)) throw collectionWriteRefusal(table);
    return;
  }

  // Addressed write: the body may name only the addressed record.
  if (BODY_ID_METHODS.has(method)) {
    let body: unknown;
    try {
      body = await deps.readBody(context);
    } catch {
      // A body that cannot be read cannot be checked: refuse rather than admit.
      throw writeBodyUnreadableRefusal(table);
    }
    const idRefusal = bodyIdRefusal(target.id, body);
    if (idRefusal) throw idRefusal;
  }

  let stored: unknown;
  try {
    stored = await deps.readStored(table, target.id);
  } catch (err) {
    throw deps.unreadable(err);
  }
  if (isForbiddenOwnerMutation(stored as Record<string, unknown> | null | undefined, ownerField, caller.agentId)) {
    throw ownerMutationRefusal(table);
  }
}

/**
 * Give every table class named in `ownerFields` and present in `tables` its own
 * static `getResource` that admits a permission-marked write through
 * `admitOwnerScopedWrite` before delegating to the inherited `getResource`.
 * Reads and writes without that marker delegate synchronously. Idempotent.
 * Returns the names of the guarded tables.
 */
export function guardOwnerScopedWrites(
  tables: Record<string, unknown> | null | undefined,
  ownerFields: Readonly<Record<string, string>>,
  deps: OwnerScopedWriteDeps,
): string[] {
  const guarded: string[] = [];
  for (const [name, ownerField] of Object.entries(ownerFields)) {
    const table = (tables as Record<string, any> | null | undefined)?.[name];
    if (typeof table !== "function") continue;
    if (Object.prototype.hasOwnProperty.call(table, OWNER_SCOPED_WRITE_GUARD)) {
      guarded.push(name);
      continue;
    }
    const inherited = table.getResource;
    if (typeof inherited !== "function") continue;
    Object.defineProperty(table, "getResource", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function getResource(this: any, target: any, context: any, options: any) {
        const method = options?.method;
        if (typeof method !== "string" || !GUARDED_WRITE_METHODS.includes(method) || !isRequestEntryTarget(target)) {
          return inherited.call(this, target, context, options);
        }
        return admitOwnerScopedWrite(name, ownerField, method, target, context, deps)
          .then(() => inherited.call(this, target, context, options));
      },
    });
    Object.defineProperty(table, OWNER_SCOPED_WRITE_GUARD, { value: true });
    guarded.push(name);
  }
  return guarded;
}

/**
 * What an installation left unguarded, given the registry, the owner-scoped
 * tables and the names `guardOwnerScopedWrites` returned. An empty or missing
 * registry yields one generic gap. Otherwise the result names every table in
 * `ownerFields` that was not guarded, including one absent from the registry
 * (it has no table class to guard), so a renamed table cannot drop out
 * silently; it is empty only when every table in `ownerFields` was guarded.
 */
export function ownerScopedWriteGuardGaps(
  tables: Record<string, unknown> | null | undefined,
  ownerFields: Readonly<Record<string, string>>,
  guarded: readonly string[],
): string[] {
  if (Object.keys(tables ?? {}).length === 0) return ["the flair table registry is missing or empty"];
  const done = new Set(guarded);
  return Object.keys(ownerFields)
    .filter((name) => !done.has(name))
    .map((name) => `${name} is not a table class with a getResource() to guard`);
}
