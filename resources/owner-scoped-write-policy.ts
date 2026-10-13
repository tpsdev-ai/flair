/**
 * Every non-admin write to an owner-scoped table is owner-checked for each
 * record it writes, however the request addresses that record.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * For a verified non-admin agent, an HTTP write (PUT, PATCH, DELETE or POST) to
 * a table listed in resources/record-owner-guard.ts's OWNER_FIELDS:
 *   - that addresses one record is refused when that record exists and its
 *     stored owner is not the caller, with `ownerMutationRefusal` (403);
 *   - that addresses no single record (the table's collection, with or without
 *     a query) is refused on PUT, PATCH and DELETE with `collectionWriteRefusal`
 *     (403): such a request does not name the records it would write, so their
 *     owners cannot be checked first. A collection POST is a create and is left
 *     to the resource's own post() and attribution rules.
 * The record checked is the one Harper resolved the request to — the record it
 * would write — never a re-parse of the URL, so every spelling of a record's
 * address gets the same decision. The owner is read from STORED state, never
 * from the request body. A refused request writes nothing: the decision is made
 * before Harper loads the record for the write, and one refusal fails the whole
 * request. When the stored record cannot be read, the request is refused with
 * the named `owner_check_unavailable` (resources/owner-field-guard.ts).
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
 * the rule there and then delegates to the inherited one. Resource classes that
 * extend a table inherit it, and the table list is OWNER_FIELDS, which
 * test/unit/record-owner-guard-coverage.test.ts derives from the schema, so a
 * table that gains an owner column is enrolled without anyone naming it here.
 * resources/owner-scoped-writes.ts installs the guard at load and logs any
 * OWNER_FIELDS table it could not guard.
 *
 * This module imports only the pure helpers in resources/record-owner-guard.ts,
 * so it is unit-tested directly (test/unit/owner-scoped-write-policy.test.ts);
 * the dependencies it needs are passed in by resources/owner-scoped-writes.ts.
 * test/integration/owner-scoped-writes.test.ts checks the rule on a real Harper.
 *
 * ── A write may name only the record it addresses ────────────────────────────
 * The guard above decides on the record the request's URL addresses. A resource
 * whose own write path sends its body to a write keyed by the body's `id`, not
 * by the address, would land on a different record than the one checked. So
 * `guardBodyAddressesTarget` refuses a non-admin write whose body `id` differs
 * from the record it addresses, with the named `write_id_not_addressed` (403)
 * that echoes neither id and writes nothing. It is a resource-layer delegate
 * (it needs the parsed body, which Harper's middleware has not parsed), scoped
 * to the same entry call as the guard: an administrator, a trusted internal
 * call and an anonymous caller are left unchanged. A create addressed to a
 * collection names its record in the body and is unaffected (there is no
 * addressed id to differ from).
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
}

/** Marks a table class whose writes have been guarded. */
export const OWNER_SCOPED_WRITE_GUARD: unique symbol = Symbol.for("flair.ownerScopedWriteGuard");

/** The Harper resource methods an HTTP request reaches to write a record. */
export const GUARDED_WRITE_METHODS: readonly string[] = Object.freeze(["put", "patch", "delete", "post"]);

/** Methods that write records already stored, and so are refused on a collection target. */
const STORED_RECORD_METHODS: ReadonlySet<string> = new Set(["put", "patch", "delete"]);

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

/**
 * Decide one entry write. Resolves when the write may proceed; rejects with the
 * refusal (a Response, which Harper's REST layer returns as is, or a named
 * error) when it may not.
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

/** The named refusal for a write whose body names a record other than the one it addresses. */
export function writeIdNotAddressedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "write_id_not_addressed",
    message: "a write may name only the record it addresses",
  }), { status: 403, headers: { "Content-Type": "application/json" } });
}

/** The id the request URL addresses, read from the resource's bound record; null when it names no single record. */
export function addressedId(resource: unknown): string | number | null {
  try {
    const getId = (resource as { getId?: () => unknown } | null | undefined)?.getId;
    const id = typeof getId === "function" ? getId.call(resource) : undefined;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Refuse a non-admin write whose body `id` names a record other than the one
 * the request addresses, with `write_id_not_addressed` (403). A resource whose
 * write path keys the table write on the body `id` would otherwise land on a
 * record other than the one the owner check read. Returns the refusal, or null
 * when the write may proceed.
 *
 * Scoped to the same entry call as the guard: only a verified non-admin agent
 * is decided here. An administrator, a trusted internal call (no resolved
 * agent) and an anonymous caller return null and keep their current behaviour
 * (an anonymous write is refused by the resource's own gate). A create
 * addressed to a collection has no addressed id and is not this rule's business.
 */
export async function guardBodyAddressesTarget(
  self: unknown,
  content: unknown,
  deps: { resolveAuth: (context: unknown) => Promise<WriteCaller> },
): Promise<Response | null> {
  const caller = await deps.resolveAuth((self as { getContext?: () => unknown } | null)?.getContext?.());
  if (caller.kind !== "agent" || caller.isAdmin === true) return null;

  const target = addressedId(self);
  if (target == null) return null; // a collection create names its record in the body

  const bodyId = content != null && typeof content === "object" ? (content as { id?: unknown }).id : undefined;
  if (bodyId == null) return null;

  if ((typeof bodyId !== "string" && typeof bodyId !== "number") || String(bodyId) !== String(target)) {
    return writeIdNotAddressedRefusal();
  }
  return null;
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
