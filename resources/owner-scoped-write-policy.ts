/**
 * Every non-admin write to an owner-scoped table is owner-checked for each
 * record it writes, however the request addresses that record.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * For a verified non-admin agent, an HTTP write to a table listed in
 * resources/record-owner-guard.ts's OWNER_FIELDS:
 *   - addressed to one record (POST/PUT/PATCH/DELETE to `/<Table>/<id>`) is
 *     refused when that record exists and its stored owner is not the caller,
 *     with `ownerMutationRefusal` (403); and, on POST/PUT/PATCH, is refused with
 *     `writeIdNotAddressedRefusal` (403) when the body carries a scalar `id`
 *     naming a different record than the one the URL addresses — so the body may
 *     name only the addressed record;
 *   - addressed to no single record (the table's collection, with or without a
 *     query) is refused on PUT, PATCH and DELETE with `collectionWriteRefusal`
 *     (403): such a request does not name the records it would write, so their
 *     owners cannot be checked first. A collection POST (a create) is NOT
 *     decided here — it stays governed by each resource's own create and
 *     attribution rules.
 * The record checked is the id Harper resolved the request's URL to, never a
 * re-parse of the path, so every spelling of a record's address gets the same
 * decision; the body-id rule then binds the write to that same record. The
 * owner is read from STORED state, never from the request body. A refused
 * request writes nothing, and one refusal fails the whole request. When the
 * guard's own stored-record read for an addressed owner check fails, the
 * request is refused with the named `owner_check_unavailable`
 * (resources/owner-field-guard.ts); a resource's own read-failure handling on
 * other paths (for example a Presence heartbeat) is unchanged.
 *
 * Administrators, trusted internal calls and anonymous callers are not decided
 * here (anonymous writes are refused by each resource's own gate). Server code
 * that writes these tables in-process is unchanged: the guard acts only on the
 * entry call of an HTTP request, the one call whose target Harper marks with the
 * request's permission set (`checkPermission`) before authorizing it.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * Harper serves a table write through the class's static put/patch/delete/post,
 * which resolves the request target to the record id it will write and then
 * calls the class's static `getResource(target, context, options)` with that
 * resolved target and the method in `options.method`. `guardOwnerScopedWrites`
 * gives every owner-scoped table class its own static `getResource` that applies
 * the rule there and then delegates to the inherited one. A resource class that
 * extends the flair table inherits it; a custom resource that extends `Resource`
 * rather than the table (for example AgentReadPosition) is not on this path and
 * enforces its own ownership. The table list is OWNER_FIELDS;
 * test/unit/record-owner-guard-coverage.test.ts fails when a table declares an
 * owner-shaped column and is neither added to that map nor exempted with a
 * stated reason, so a new owner-scoped table has to be enrolled there — it is
 * not picked up automatically. resources/owner-scoped-writes.ts installs the
 * guard at load and logs any OWNER_FIELDS table it could not guard.
 *
 * This module imports only the pure helpers in resources/record-owner-guard.ts,
 * so it is unit-tested directly (test/unit/owner-scoped-write-policy.test.ts);
 * the dependencies it needs are passed in by resources/owner-scoped-writes.ts.
 * test/integration/owner-scoped-writes.test.ts checks the rule on a real Harper.
 *
 * ── A write may name only the record it addresses ────────────────────────────
 * An addressed write (POST, PUT or PATCH to `/<Table>/<id>`) is owner-checked on
 * the record its URL addresses, and its body may name only that record: a
 * non-admin request whose body `id` is a value that names a different record
 * than the one the URL addresses is refused with `write_id_not_addressed` (403),
 * which echoes neither id and writes nothing. A body with no `id`, or one that
 * names the addressed record, proceeds. This is decided here, at the entry call,
 * on the addressed id — so a resource whose own write path later keys the table
 * write on the body `id` cannot land on a record other than the one checked.
 * A non-scalar body `id` is left to each resource's own request handling.
 * A create addressed to a collection names its record in the body and is not
 * this rule's business (there is no addressed id to differ from); it stays
 * governed by each resource's own create rules.
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
  /** The parsed request body for this entry call (Harper's `request.data`), or a promise for it. */
  readBody: (context: unknown) => unknown;
}

/** Marks a table class whose writes have been guarded. */
export const OWNER_SCOPED_WRITE_GUARD: unique symbol = Symbol.for("flair.ownerScopedWriteGuard");

/** The Harper resource methods an HTTP request reaches to write a record. */
export const GUARDED_WRITE_METHODS: readonly string[] = Object.freeze(["put", "patch", "delete", "post"]);

/** Methods that write records already stored, and so are refused on a collection target. */
const STORED_RECORD_METHODS: ReadonlySet<string> = new Set(["put", "patch", "delete"]);

/** Methods that carry a record body whose `id` must name the addressed record. */
const BODY_ID_METHODS: ReadonlySet<string> = new Set(["put", "patch", "post"]);

/**
 * Whether `target` is an HTTP request's own entry target. Harper's REST layer
 * sets `checkPermission` (the caller's permission set, never null) on it before
 * the entry call and clears it to `false` once that call is authorized; targets
 * built by server code carry no value.
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

/** The named refusal for a write whose body names a record other than the one it addresses. */
export function writeIdNotAddressedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "write_id_not_addressed",
    message: "a write may name only the record it addresses",
  }), { status: 403, headers: { "Content-Type": "application/json" } });
}

/**
 * Whether a parsed request `body` carries a scalar `id` that names a record
 * other than `targetId` (the addressed record). A body with no `id`, an `id`
 * equal to the target, or a non-scalar `id` (left to each resource's own
 * request handling) is not a mismatch.
 */
export function bodyNamesDifferentRecord(targetId: unknown, body: unknown): boolean {
  if (targetId == null) return false;
  if (body == null || typeof body !== "object" || Array.isArray(body)) return false;
  const bodyId = (body as { id?: unknown }).id;
  if (bodyId == null) return false;
  if (typeof bodyId !== "string" && typeof bodyId !== "number") return false;
  return String(bodyId) !== String(targetId);
}

/**
 * Decide one entry write. Resolves when the write may proceed; rejects with the
 * refusal (a Response, which Harper's REST layer returns as is, or a named
 * error) when it may not.
 *
 * In order: resolve the caller (an unresolvable one is refused); leave an
 * administrator, a trusted internal call and an anonymous caller to their
 * existing handling; refuse a collection PUT/PATCH/DELETE; refuse a write whose
 * body names a record other than the addressed one; then refuse a write to a
 * stored record owned by another principal. Each refusal writes nothing.
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

  if (addressesNoSingleRecord(target)) {
    if (STORED_RECORD_METHODS.has(method)) throw collectionWriteRefusal(table);
    return;
  }

  // Addressed write: the body may name only the addressed record. Harper has
  // parsed the body onto the request by now; a body that cannot be read is left
  // to Harper's own request handling.
  if (BODY_ID_METHODS.has(method)) {
    let body: unknown;
    try {
      body = await deps.readBody(context);
    } catch {
      body = undefined;
    }
    if (bodyNamesDifferentRecord(target.id, body)) throw writeIdNotAddressedRefusal();
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
 * static `getResource` that admits an HTTP entry write through
 * `admitOwnerScopedWrite` before delegating to the inherited `getResource`.
 * Every other call — a read, or any call server code makes — is delegated
 * unchanged and synchronously. Idempotent. Returns the names of the guarded
 * tables.
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
 * tables and the names `guardOwnerScopedWrites` returned. Empty when every
 * owner-scoped table in the registry is guarded. A table listed in
 * `ownerFields` but absent from the registry has no table class to guard and
 * is reported too, so a renamed table cannot drop out silently.
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
