/**
 * record-owner-guard.ts — ONE enforcement point for "you may not modify a
 * record you do not own".
 *
 * ─── The defect this deletes ─────────────────────────────────────────────────
 *
 * Harper's REST layer maps verbs to resource methods ONE-TO-ONE (see
 * harper/dist/server/REST.js's method switch): GET→get, POST→post, PUT→put,
 * PATCH→patch, DELETE→delete. There is no fallback — `patch()` does NOT route
 * through `put()`. So an ownership rule written inside a resource's `put()` is
 * enforced on PUT and on nothing else, and a resource with no `patch()` override
 * reaches the table with only its `allow*` gate, which is typically
 * `allowVerified()` — "any verified agent".
 *
 * Almost every flair resource wrote its per-record rules in `put()`. That is not
 * a mistake anyone made once; it is what the resource model invites, because
 * `put()` is where the write logic naturally goes and nothing anywhere says the
 * other verbs exist. Fixing it resource-by-resource would mean N hand-written
 * guards — N chances to get one subtly wrong — and would still leave the NEXT
 * resource broken by default, because its author would have to know this file
 * exists to be safe. So the rule lives here instead, once, on the path every
 * HTTP request already takes.
 *
 * ─── The rule, and why it is this narrow ─────────────────────────────────────
 *
 *   On a record that ALREADY EXISTS, a non-admin caller whose agent id does not
 *   match the record's stored owner is refused — on every mutating verb.
 *
 * It deliberately says nothing about creation. Over-blocking is the failure mode
 * a security fix reaches for, and a blunter rule ("the caller must own whatever
 * it names") would break real flows: Presence heartbeats arrive at the
 * collection with no record yet, credential provisioning creates rows for other
 * principals, and a MemoryGrant's `granteeId` is SUPPOSED to be someone else.
 * Restricting this to records that exist means the guard can only ever narrow
 * mutation of another agent's data. It cannot break a create, and it cannot
 * break an agent writing its own record.
 *
 * ─── Owner is read from STORED STATE, never from the request body ────────────
 *
 * The guards this replaces compared the owner field in the request BODY — the
 * owner the CALLER CLAIMS — and denied only when that field was present and
 * mismatched. A body that simply omitted it was compared against nothing and
 * passed, whatever record the URL named. Harper binds the write to the URL's id,
 * not to the body, so body-derived authorization was answering a question nobody
 * asked. That is the same defect as the verb gap wearing different clothes: an
 * authorization decision made against attacker-supplied data instead of stored
 * state. Both are closed here, together, because closing one leaves the other
 * reachable.
 *
 * Per-resource body checks (no-forge attribution on CREATE) still belong in the
 * resources — they answer a different question, "may you attribute a NEW record
 * to someone else", which this guard does not address.
 *
 * ─── Keeping this honest as the codebase grows ───────────────────────────────
 *
 * OWNER_FIELDS below is static and PR-reviewed, matching the posture of
 * resources/record-types.ts. A static map alone would rot, so
 * test/unit/record-owner-guard-coverage.test.ts parses `schemas/*.graphql` and
 * FAILS when a table declares an owner-shaped column and is neither listed here
 * nor exempted with a stated reason. A table added later enters that test's
 * scope the moment it declares the column — nobody has to know this file exists.
 */

/**
 * Table → the attribute naming the principal that owns a row.
 *
 * Derived from the columns actually declared in `schemas/*.graphql`, and pinned
 * against them by the coverage test. Tables with no resource class are listed
 * anyway: costing nothing when the route does not exist is much better than
 * being absent on the day someone adds one.
 */
export const OWNER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  Credential: "principalId",
  Integration: "agentId",
  Memory: "agentId",
  MemoryCandidate: "agentId",
  MemoryGrant: "ownerId",
  MemoryUsage: "agentId",
  OAuthAuthCode: "principalId",
  OAuthToken: "principalId",
  OrgEvent: "authorId",
  Presence: "agentId",
  Relationship: "agentId",
  Soul: "agentId",
  WorkspaceState: "agentId",
});

/**
 * Tables that declare an owner-shaped column but are deliberately NOT guarded
 * here, each with the reason. The coverage test accepts these and rejects
 * anything else, so an omission has to be argued rather than merely happen.
 */
export const OWNER_GUARD_EXEMPT: Readonly<Record<string, string>> = Object.freeze({
  // The principal table's own rule is "the record IS the caller", not "the
  // record has an owner column" — a principal may edit itself, and only an
  // admin may change anyone's admin status. That is enforced in
  // resources/Agent.ts's shared write-authorization helper, which both its
  // put() and its patch() route through.
  Agent: "self-ownership by primary key; enforced in resources/Agent.ts for every verb",
});

/** The verbs that can mutate a record, and therefore need the rule applied. */
export const MUTATING_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.includes(method.toUpperCase());
}

/**
 * Resolve a request path to the guarded table and record id it addresses, or
 * null when the path is not a guarded single-record route.
 *
 * Matches `/<Table>/<id>` ONLY. A collection path (`/<Table>`) addresses no
 * existing record, so there is nothing to own and nothing to check — that is the
 * "creation is untouched" property, expressed as a parse rather than a special
 * case. The table segment is matched EXACTLY so `/SoulFeed/x` can never be read
 * as a `Soul` route.
 */
export function resolveGuardedRecord(pathname: string): { table: string; ownerField: string; id: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const table = parts[0];
  const ownerField = OWNER_FIELDS[table];
  if (!ownerField) return null;
  let id: string;
  try {
    id = decodeURIComponent(parts[1]);
  } catch {
    return null; // malformed percent-encoding addresses no record we can resolve
  }
  if (!id) return null;
  return { table, ownerField, id };
}

/**
 * Decide whether a caller may mutate an already-stored record.
 *
 * Pure, so the decision is testable without a Harper instance — the middleware
 * supplies the record it loaded. A record that does not exist, or that carries
 * no owner value, is NOT refused here: the first is a create (or a 404 the
 * resource will produce), and the second is a row with nothing to own, neither
 * of which this rule is about.
 */
export function isForbiddenOwnerMutation(
  record: Record<string, unknown> | null | undefined,
  ownerField: string,
  callerAgentId: string | null | undefined,
): boolean {
  if (!record) return false;
  const owner = record[ownerField];
  if (owner == null || owner === "") return false;
  return owner !== callerAgentId;
}
