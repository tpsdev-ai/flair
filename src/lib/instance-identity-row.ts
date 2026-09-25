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
 *
 * Nothing here reads "the first row". `search()` order is not a fact about an
 * identity, and a decision built on it is a coin toss that reports as an answer.
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
 * Role comparison is case/space-insensitive: the value round-trips through
 * YAML, JSON and the ops API, and `"Hub"` must not read as "not a hub" — a
 * strict comparison there silently disables the sweep, which is the defect.
 */
export function normalizeRole(role: unknown): string {
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

/** Rows that carry a usable id, in the order they were read. */
export function usableInstanceRows(rows: readonly InstanceIdentityRow[] | null | undefined): InstanceIdentityRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => !!r && typeof r.id === "string" && r.id.length > 0);
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

/** The refusal for a multi-row Instance table: every row, then the remedy. */
export function multipleInstanceRowsMessage(rows: readonly InstanceIdentityRow[], context = "flair init --remote"): string {
  const usable = usableInstanceRows(rows);
  return [
    `${context} refused: this instance has ${usable.length} Instance rows, so it has no single canonical identity.`,
    ...usable.map((r) => `  ${formatInstanceRow(r)}`),
    `Keep one row and delete the rest with: ${INSTANCE_ROW_PRUNE_COMMAND} --keep <id>`,
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

  if (usable.length > 1) {
    findings.push({
      code: "instance-multiple-rows",
      status: "fail",
      detail: `${usable.length} Instance rows (${usable.map((r) => formatInstanceRow(r)).join("; ")})`,
      remedy: `${INSTANCE_ROW_PRUNE_COMMAND} --keep <id>`,
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
        detail: `the ${PAIR_INITIATOR_ROLE} role exists while this instance is not a hub (${described})`,
        remedy: "flair init --remote",
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
 * Every Instance row on this instance. Never "the first one" — the caller
 * decides, and a decision needs the whole set.
 */
export async function readInstanceRows(endpoint: OpsEndpoint): Promise<InstanceIdentityRow[]> {
  const parsed = await opsPost(
    endpoint,
    {
      operation: "search_by_conditions",
      schema: "flair",
      table: "Instance",
      operator: "and",
      conditions: [
        { search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" },
      ],
      get_attributes: ["id", "role", "publicKey", "status", "createdAt"],
    },
    "Instance search",
  );
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
  return usableInstanceRows(rows as InstanceIdentityRow[]);
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
 * An id that names no row is `unknown-id`, not `nothing`: "nothing to do" after
 * a typo reads as a successful prune of the row the operator meant to keep.
 */
export function decideInstancePrune(
  rows: readonly InstanceIdentityRow[] | null | undefined,
  keepId: string,
): InstancePruneDecision {
  const usable = usableInstanceRows(rows);
  const keep = usable.find((r) => r.id === keepId);
  if (!keep) {
    if (usable.length <= 1) return { kind: "nothing" };
    return { kind: "unknown-id", rows: usable };
  }
  const drop = usable.filter((r) => r.id !== keepId);
  if (drop.length === 0) return { kind: "nothing" };
  return { kind: "keep", keep, drop };
}
