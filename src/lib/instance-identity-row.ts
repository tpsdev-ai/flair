/**
 * instance-identity.ts — the ONE canonical Instance identity row (flair#1883).
 *
 * A Flair instance's identity lives in `flair.Instance`: `id`, `publicKey`,
 * `role`. Two writers disagreed about it. `GET /FederationInstance` FIND-OR-
 * CREATES a row (`role: "spoke"`) on first read; `flair init --remote` INSERTed
 * a SECOND row with a fresh random id. So a hub that had answered a GET before
 * init finished carried a spoke row AND a hub row — and everything downstream
 * that read "the first row of an unordered search()" answered differently
 * depending on which row the table yielded first. On an affected hub the
 * pairing-cleanup sweep found no `hub` role at all and stayed off, so expired
 * bootstrap users accumulated.
 *
 * This module is the decision layer both writers and the cleanup sweep share:
 * pure functions over the rows, plus the ops-API reads/writes the CLI needs.
 * The rules (flair#1883):
 *
 *   - exactly one row   → that row IS the identity; `--remote` sets its role to
 *                         `hub` and keeps its id and key (peers know it).
 *   - no row            → `--remote` creates one, `role: "hub"`.
 *   - more than one row → a REFUSAL naming every row, never a silent pick.
 *                         The READERS obey this too (flair#1883 round 3):
 *                         `GET /FederationInstance` and `POST /FederationPair`
 *                         answer a 409 that names the prune, rather than report
 *                         whichever row the search happened to yield first.
 *
 * Nothing here reads "the first row". `search()` order is not a fact about an
 * identity, and a decision built on it is a coin toss that reports as an answer.
 *
 * The read is unconditional (flair#1883 round 2): an ops-API
 * `search_by_conditions` needs at least one condition, and the
 * `createdAt > "1970-01-01"` one this module used to send EXCLUDED every row
 * whose `createdAt` compares BELOW that string — a date before 1970, an empty
 * string. The column is REQUIRED (`createdAt: String! @indexed`,
 * schemas/federation.graphql), so no legal row omits it; the date-shaped filter
 * was the wrong instrument regardless, because it could hide a row the table is
 * allowed to hold. A row no reader can see is a row `init --remote` does not
 * know about, and the second identity it then inserts is the defect this module
 * exists to end.
 *
 * A read must also ESTABLISH something to be an answer (flair#1883 rounds 3-4).
 * A read that FAILS is not an answer — `null` is its own state (see
 * `decideSweepMode`, `probeInstanceIdentity`). A 200 whose body is not a row
 * list is not a read of zero rows (`readInstanceRows` throws). And a row the
 * reader cannot NAME — an entry with no usable id — makes the whole read
 * unreadable (`readableInstanceRows`): such an entry may be one of several
 * identity rows, and a reader that drops it cannot tell a table it saw from a
 * table it only saw part of. Only a SUCCESSFUL read of zero rows may create.
 */

/** One `flair.Instance` row, as read from the table or the ops API. */
export interface InstanceIdentityRow {
  id: string;
  role?: string | null;
  publicKey?: string | null;
  status?: string | null;
  createdAt?: string | null;
}

/** The role a properly-provisioned hub's identity row carries. */
export const HUB_ROLE = "hub";

/** The Harper role pairing bootstrap users hold; only meaningful on a hub. */
export const PAIR_INITIATOR_ROLE = "flair_pair_initiator";

/**
 * The ONE command that resolves a multi-row Instance table. Named by init's
 * refusal and by `flair doctor`, so an operator who reads either has the fix.
 * `--keep <id>` is the row to keep; the rest are deleted (dry-run by default).
 */
export const INSTANCE_ROW_PRUNE_COMMAND = "flair federation instance prune";

/**
 * The prune invocation to hand an operator, naming BOTH forms: the dry run is
 * the command with no `--apply`, and only `--apply` deletes. A remedy that shows
 * the bare command deletes nothing (flair#1883 round 2) — it prints what it
 * WOULD delete and exits 0, which reads as a successful prune.
 */
export const INSTANCE_ROW_PRUNE_REMEDY = `${INSTANCE_ROW_PRUNE_COMMAND} --keep <id> (dry run; add --apply to delete)`;

/**
 * Role comparison is case/space-insensitive: the value round-trips through
 * YAML, JSON and the ops API, and `"Hub"` must not read as "not a hub" — a
 * strict comparison there silently disables the sweep, which is the defect.
 */
export function normalizeRole(role: unknown): string {
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

/**
 * Whether a reader can NAME this entry: a non-null object with a non-empty
 * string id. The ONE definition of "usable", shared by the pure decisions below
 * (which filter rows already in hand) and by the readers (which refuse a read
 * that returned an entry it cannot name — flair#1883 round 4).
 */
export function isUsableInstanceRow(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
}

/**
 * Rows that carry a usable id, in the order they were read.
 *
 * This DROPS an entry it cannot name, which is right for a decision over rows
 * already in hand and WRONG for a read: `[{}]`, `{results: [null]}` and a good
 * row beside a bad one would all become "the rows I could name". The readers use
 * `readableInstanceRows` instead (flair#1883 round 4).
 */
export function usableInstanceRows(rows: readonly InstanceIdentityRow[] | null | undefined): InstanceIdentityRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => isUsableInstanceRow(r));
}

/**
 * Every entry of a COMPLETED read, in order — or a thrown error naming the first
 * entry the reader cannot name (flair#1883 round 4).
 *
 * A malformed row is not a missing row. Dropping it makes `[{}]`, or a good row
 * beside a bad one, read as "the rows I could name" — a read that established
 * nothing still looks like a read of one row (or none), and `flair init
 * --remote` creates an identity on the strength of it while `flair doctor`
 * prints "no rows" for a table it only part saw. An entry without a usable id
 * may be one of several identity rows, so the read is UNREADABLE — the same
 * outcome as a failed read: the callers answer 5xx / report the probe as
 * unreadable, and NOTHING is created, changed or deleted on the strength of it.
 */
export function readableInstanceRows(entries: readonly unknown[]): InstanceIdentityRow[] {
  const out: InstanceIdentityRow[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (!isUsableInstanceRow(entries[i])) {
      throw new Error(
        `Instance read: row ${i + 1} of ${entries.length} carries no usable id — treating the read as UNREADABLE. ` +
          "An entry a reader cannot name may be one of several identity rows, and a read that cannot name every row it " +
          "returned is not a read that found no rows: it must not license creating an identity.",
      );
    }
    out.push(entries[i] as InstanceIdentityRow);
  }
  return out;
}

/** `id=… role=… createdAt=…` — every field named, never positionally. */
export function formatInstanceRow(row: InstanceIdentityRow): string {
  const role = typeof row.role === "string" && row.role.length > 0 ? row.role : "(none)";
  const createdAt = typeof row.createdAt === "string" && row.createdAt.length > 0 ? row.createdAt : "(unknown)";
  return `id=${row.id} role=${role} createdAt=${createdAt}`;
}

/** The role of the canonical row, or null when there is not exactly one. */
export function canonicalInstanceRole(rows: readonly InstanceIdentityRow[] | null | undefined): string | null {
  const usable = usableInstanceRows(rows);
  if (usable.length !== 1) return null;
  const role = normalizeRole(usable[0].role);
  return role.length > 0 ? role : null;
}

// ─── init --remote: reconcile, never insert ─────────────────────────────────

export type HubReconcileDecision =
  | { kind: "create" }
  | { kind: "already-hub"; id: string }
  | { kind: "update-role"; id: string }
  | { kind: "refuse-multiple"; rows: InstanceIdentityRow[] };

/**
 * What `flair init --remote` must do to this instance's identity rows.
 *
 * `already-hub` is its own outcome, not a flavour of `update-role`: a re-run
 * must not write anything (the issue's "re-running is a no-op").
 */
export function decideHubReconcile(rows: readonly InstanceIdentityRow[] | null | undefined): HubReconcileDecision {
  const usable = usableInstanceRows(rows);
  if (usable.length === 0) return { kind: "create" };
  if (usable.length > 1) return { kind: "refuse-multiple", rows: usable };
  const row = usable[0];
  return normalizeRole(row.role) === HUB_ROLE ? { kind: "already-hub", id: row.id } : { kind: "update-role", id: row.id };
}

// ─── answering with one identity (flair#1883 round 3) ───────────────────────

export type InstanceAnswerDecision =
  | { kind: "answer"; row: InstanceIdentityRow }
  | { kind: "none" }
  | { kind: "refuse-multiple"; rows: InstanceIdentityRow[] };

/**
 * What a READER answers with, given every Instance row it could read.
 *
 * This is the server side of the same rule the writers follow, and it exists
 * because two readers still answered with the first row of an unordered search:
 * `GET /FederationInstance` (`resources/Federation.ts`) and the hub identity in
 * the `POST /FederationPair` response, which a spoke PINS as its hub peer
 * (`src/commands/federation.ts`) — so a coin toss there becomes the identity a
 * peer keeps. More than one row is therefore a refusal, not a pick.
 *
 * `none` is a real outcome and is the caller's to interpret: `GET` creates its
 * first identity from it, and `POST /FederationPair` reports `instance: null`
 * (flair#839 — the spoke must error rather than store an empty key).
 *
 * A count of zero here means the read SUCCEEDED and found nothing. A read that
 * failed never reaches this function (the caller answers 503 and writes
 * nothing); a read that returned an unparseable body is a failure too (see
 * `readInstanceRows`) — never a zero.
 */
export function decideInstanceAnswer(
  rows: readonly InstanceIdentityRow[] | null | undefined,
): InstanceAnswerDecision {
  const usable = usableInstanceRows(rows);
  if (usable.length === 0) return { kind: "none" };
  if (usable.length > 1) return { kind: "refuse-multiple", rows: usable };
  return { kind: "answer", row: usable[0] };
}

/** The refusal for a multi-row Instance table: every row, then the remedy. */
export function multipleInstanceRowsMessage(rows: readonly InstanceIdentityRow[], context = "flair init --remote"): string {
  const usable = usableInstanceRows(rows);
  return [
    `${context} refused: this instance has ${usable.length} Instance rows, so it has no single canonical identity.`,
    ...usable.map((r) => `  ${formatInstanceRow(r)}`),
    `Keep one row and delete the rest with: ${INSTANCE_ROW_PRUNE_REMEDY}`,
  ].join("\n");
}

// ─── the cleanup sweep: follow the role, not the startup moment ─────────────

export type SweepMode = "hub" | "not-hub" | "multiple" | "unreadable";

/**
 * Whether the pairing-cleanup sweep should run, from the CURRENT rows.
 *
 * `unreadable` is its own state: an Instance read that failed is not a spoke.
 * Both mean "do not sweep", but only one of them is worth a log line, and
 * neither may be reported as the other.
 */
export function decideSweepMode(rows: readonly InstanceIdentityRow[] | null): SweepMode {
  if (rows === null) return "unreadable";
  const usable = usableInstanceRows(rows);
  if (usable.length > 1) return "multiple";
  if (usable.length === 0) return "not-hub";
  return normalizeRole(usable[0].role) === HUB_ROLE ? "hub" : "not-hub";
}

// ─── doctor findings ────────────────────────────────────────────────────────

export interface InstanceIdentityFinding {
  code: "instance-multiple-rows" | "pair-role-not-hub";
  status: "fail";
  detail: string;
  remedy: string;
}

/**
 * What doctor prints when there is NO finding: the row facts, and — when the
 * role list could not be read — that the pairing-role check is UNVERIFIED.
 *
 * A finding list that is empty because a read FAILED must not render like a
 * finding list that is empty because the instance is consistent (flair#1883
 * round 2): the rows were read, so the row facts are facts, but the pairing-role
 * half of the check did not run.
 */
export function instanceIdentitySummary(input: {
  rows: readonly InstanceIdentityRow[];
  roleNames: readonly string[] | null;
}): { level: "ok" | "unverified"; text: string } {
  const usable = usableInstanceRows(input.rows);
  const described =
    usable.length === 0 ? "no rows" : `one row, role=${canonicalInstanceRole(usable) ?? "(none)"}`;
  if (input.roleNames === null) {
    return {
      level: "unverified",
      text: `${described}; the ${PAIR_INITIATOR_ROLE} pairing-role check is UNVERIFIED (the role list could not be read)`,
    };
  }
  return { level: "ok", text: described };
}

/**
 * The findings `flair doctor` reports about this instance's identity.
 *
 * `rows: null` or `roleNames: null` means the read did not happen — every
 * finding that would depend on it is omitted rather than guessed. A check that
 * cannot see the state must be silent, never green.
 */
export function instanceIdentityFindings(input: {
  rows: readonly InstanceIdentityRow[] | null;
  roleNames: readonly string[] | null;
}): InstanceIdentityFinding[] {
  const { rows, roleNames } = input;
  if (rows === null) return [];
  const findings: InstanceIdentityFinding[] = [];
  const usable = usableInstanceRows(rows);

  const multiple = usable.length > 1;
  if (multiple) {
    findings.push({
      code: "instance-multiple-rows",
      status: "fail",
      detail: `${usable.length} Instance rows (${usable.map((r) => formatInstanceRow(r)).join("; ")})`,
      remedy: INSTANCE_ROW_PRUNE_REMEDY,
    });
  }

  if (roleNames !== null) {
    const hasPairRole = roleNames.some((name) => normalizeRole(name) === PAIR_INITIATOR_ROLE);
    const canonicalRole = canonicalInstanceRole(usable);
    if (hasPairRole && canonicalRole !== HUB_ROLE) {
      const described = canonicalRole ?? (usable.length === 0 ? "no Instance row" : "no single Instance row");
      findings.push({
        code: "pair-role-not-hub",
        status: "fail",
        // With several rows present, `init --remote` refuses until the table is
        // back to one row (its own refusal names the prune). The remedies are
        // printed in the order they WORK: prune first, then init.
        detail: `the ${PAIR_INITIATOR_ROLE} role exists while this instance is not a hub (${described})`,
        remedy: multiple
          ? `${INSTANCE_ROW_PRUNE_REMEDY}, then flair init --remote`
          : "flair init --remote",
      });
    }
  }

  return findings;
}

/**
 * One finding as two printed lines (headline, then the fix), so the plain text
 * is testable without doctor's colour wrapper. The caller prefixes the icon.
 */
export function instanceIdentityFindingLines(finding: InstanceIdentityFinding): [headline: string, remedy: string] {
  return [`Instance identity: ${finding.detail}`, `Fix: ${finding.remedy}`];
}

// ─── ops-API access ─────────────────────────────────────────────────────────

export interface OpsEndpoint {
  /** Ops API base URL, with or without a trailing slash. */
  opsUrl: string;
  /** Basic credentials: `user:pass` (used to build the Authorization header). */
  credentials?: { user: string; pass: string };
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function authHeaderFor(endpoint: OpsEndpoint): string | undefined {
  const creds = endpoint.credentials;
  if (!creds) return undefined;
  return `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
}

function opsBaseUrl(opsUrl: string): string {
  return `${opsUrl.replace(/\/$/, "")}/`;
}

async function opsPost(endpoint: OpsEndpoint, body: Record<string, unknown>, what: string): Promise<any> {
  const fetchImpl = endpoint.fetchImpl ?? fetch;
  const auth = authHeaderFor(endpoint);
  const res = await fetchImpl(opsBaseUrl(endpoint.opsUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(endpoint.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what} via ops API failed (${res.status}): ${text || "no body"}`);
  }
  return await res.json().catch(() => null);
}

/**
 * Every Instance row on this instance, UNCONDITIONALLY — no WHERE clause, no
 * comparator over a column a row may not carry. Never "the first one", and never
 * "the ones that happen to have a createdAt": the caller decides, and a decision
 * needs the whole set (flair#1883 round 2).
 *
 * SQL is the ops operation that can say "all": `search_by_conditions` requires at
 * least one condition (Harper's searchValidator: `conditions` is `.min(1)`), and
 * any single condition can hide a row.
 */
export const INSTANCE_ROWS_SQL = "SELECT id, role, publicKey, status, createdAt FROM flair.Instance";

export async function readInstanceRows(endpoint: OpsEndpoint): Promise<InstanceIdentityRow[]> {
  const parsed = await opsPost(
    endpoint,
    { operation: "sql", sql: INSTANCE_ROWS_SQL },
    "Instance read",
  );
  // A 200 whose body is not a row list is a read that established NOTHING
  // (flair#1883 round 3). It used to become `[]`, which is the same value a
  // successful read of zero rows returns — so `flair init --remote` would create
  // an identity on the strength of a read it never made, and `flair doctor`
  // would print "no rows" for a table it never saw. Unreadable is its own state
  // and follows the failed-read path: throw. `opsPost` returns null for a body
  // that does not parse at all, so both the invalid-JSON and the
  // unexpected-shape case land here.
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
  if (rows === null) {
    throw new Error(
      "Instance read via ops API answered 200 with a body that is neither a row array nor { results: [...] } — " +
        "treating the read as UNREADABLE. A read that established nothing is not a read that found no rows, and it " +
        "must not license creating an identity.",
    );
  }
  // Every entry must be nameable (flair#1883 round 4): a body carrying an entry
  // without a usable id established nothing about the table, and it follows the
  // failed-read path rather than reporting the rows it could name.
  return readableInstanceRows(rows);
}

/** Role names on this instance, or null when the read did not happen. */
export async function readRoleNames(endpoint: OpsEndpoint): Promise<string[] | null> {
  try {
    const parsed = await opsPost(endpoint, { operation: "list_roles" }, "list_roles");
    const roles = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.roles) ? parsed.roles : null;
    if (roles === null) return null;
    return roles
      .map((r: any) => (typeof r === "string" ? r : r?.role ?? r?.name))
      .filter((name: unknown): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

/**
 * Set the canonical row's role, keeping its id and key. Verified against the
 * result body: a Harper `update` answers 200 with the changed hashes in
 * `update_hashes` and names a miss in `skipped_hashes`, so HTTP status alone
 * would let a missing row read as a successful reconcile.
 */
export async function updateInstanceRole(endpoint: OpsEndpoint, id: string, role: string): Promise<void> {
  const parsed = await opsPost(
    endpoint,
    {
      operation: "update",
      database: "flair",
      table: "Instance",
      records: [{ id, role, updatedAt: new Date().toISOString() }],
    },
    `Instance role update for ${id}`,
  );
  const updated = Array.isArray(parsed?.update_hashes) ? parsed.update_hashes : null;
  if (updated === null || !updated.includes(id)) {
    const skipped = Array.isArray(parsed?.skipped_hashes) ? parsed.skipped_hashes.join(", ") : "unknown";
    throw new Error(
      `Instance role update for ${id} changed no row (skipped: ${skipped}). ` +
        `The row was deleted or replaced between the read and the write — re-run and check ${INSTANCE_ROW_PRUNE_COMMAND} for a second row.`,
    );
  }
}

/** Delete one Instance row. Used only by `flair federation instance prune`. */
export async function deleteInstanceRow(endpoint: OpsEndpoint, id: string): Promise<void> {
  // `hash_values` is the field Harper's delete schema REQUIRES (a list); the
  // singular `hash_value` is refused with a 400. Verified against a live Harper
  // in test/integration/init-remote-instance-identity.test.ts.
  await opsPost(
    endpoint,
    { operation: "delete", database: "flair", table: "Instance", hash_values: [id] },
    `Instance delete for ${id}`,
  );
}

/** Every row this instance holds, or a thrown error. Doctor uses the probe. */
export async function listInstanceRows(endpoint: OpsEndpoint): Promise<InstanceIdentityRow[]> {
  return await readInstanceRows(endpoint);
}

/**
 * Read both identity facts doctor needs, degrading to `null` on failure.
 *
 * A read that did not happen must be distinguishable from a read that found
 * nothing: doctor reports the first as unverified and the second as absent.
 */
export async function probeInstanceIdentity(
  endpoint: OpsEndpoint,
): Promise<{ rows: InstanceIdentityRow[] | null; roleNames: string[] | null }> {
  let rows: InstanceIdentityRow[] | null = null;
  try {
    rows = await readInstanceRows(endpoint);
  } catch {
    rows = null;
  }
  const roleNames = await readRoleNames(endpoint);
  return { rows, roleNames };
}

/**
 * What a prune prints when it is about to delete rows (flair#1883 round 3).
 *
 * A peer PINS this instance's identity when it pairs: it is handed `{ id,
 * publicKey, role }` in the `POST /FederationPair` response and stores it as its
 * hub peer. That response was read from the Instance table and — while the table
 * held more than one row — it was whichever row the search yielded first, which
 * is precisely the state a prune exists to resolve. A peer that paired in that
 * state therefore pinned one of the rows, and WHICH one is not determinable
 * here; this helper does not pretend otherwise.
 *
 * Round 2 named the row the hub answered `GET /FederationInstance` with. That
 * was a guess dressed as a fact: with several rows the GET now refuses (409)
 * rather than answer one, and a peer was never handed the GET's answer anyway.
 * What is true, and what the operator needs, is simpler: every row being deleted
 * is a row a paired peer MAY have pinned, and a peer paired with a deleted
 * identity must re-pair.
 */
export function prunePeerWarningLines(input: { drop: readonly InstanceIdentityRow[] }): string[] {
  const drop = usableInstanceRows(input.drop);
  if (drop.length === 0) return [];
  return [
    "Paired peers pinned this instance's identity from the POST /FederationPair response. While the table held " +
      "more than one Instance row, that response was whichever row the search yielded first — so which row a " +
      "given peer pinned cannot be determined here.",
    `Any of the ${drop.length} row(s) being deleted may be the identity a paired peer pinned. ` +
      "A peer paired with a deleted identity must re-pair.",
  ];
}

/**
 * `flair federation instance prune --keep <id>` — delete every OTHER Instance
 * row, so the instance is back to one canonical identity. The kept row is never
 * touched: its id and key are what peers know.
 *
 * Refuses an id that names no row (a typo must not read as a successful prune).
 */
export async function pruneInstanceRows(endpoint: OpsEndpoint, keepId: string): Promise<{ dropped: string[] }> {
  const rows = await readInstanceRows(endpoint);
  const decision = decideInstancePrune(rows, keepId);
  if (decision.kind === "unknown-id") {
    throw new Error(
      `--keep ${keepId} names no Instance row on this instance. Rows present: ` +
        decision.rows.map((r) => `\n  ${formatInstanceRow(r)}`).join(""),
    );
  }
  if (decision.kind === "nothing") return { dropped: [] };
  const dropped: string[] = [];
  for (const row of decision.drop) {
    await deleteInstanceRow(endpoint, row.id);
    dropped.push(row.id);
  }
  return { dropped };
}

// ─── flair federation instance prune ────────────────────────────────────────

export type InstancePruneDecision =
  | { kind: "nothing" }
  | { kind: "keep"; keep: InstanceIdentityRow; drop: InstanceIdentityRow[] }
  | { kind: "unknown-id"; rows: InstanceIdentityRow[] };

/**
 * Which rows `prune --keep <id>` deletes.
 *
 * An id that names no row is `unknown-id`, not `nothing`, at EVERY row count:
 * "nothing to do" after a typo reads as a successful prune of the row the
 * operator meant to keep.
 */
export function decideInstancePrune(
  rows: readonly InstanceIdentityRow[] | null | undefined,
  keepId: string,
): InstancePruneDecision {
  const usable = usableInstanceRows(rows);
  const keep = usable.find((r) => r.id === keepId);
  if (!keep) {
    // Refused whatever the row count (flair#1883 round 2). With zero or one row
    // there is nothing to delete either, but an id that names no row is a TYPO
    // until proven otherwise, and "nothing to do" after a typo reads as a
    // successful prune of the row the operator meant to keep.
    return { kind: "unknown-id", rows: usable };
  }
  const drop = usable.filter((r) => r.id !== keepId);
  if (drop.length === 0) return { kind: "nothing" };
  return { kind: "keep", keep, drop };
}
