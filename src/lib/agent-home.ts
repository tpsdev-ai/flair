/**
 * agent-home.ts — the CLI-side half of the Agent "home instance" rule
 * (flair#2433).
 *
 * An Agent row's home is `originatorInstanceId`: the federation id of the
 * instance that CREATED it. The Agent resource stamps it on every create
 * (resources/Agent.ts via resources/originator-instance.ts, reading
 * resources/instance-identity.ts's localInstanceId()). The Agent rows the CLI
 * creates go through Harper's operations API, which bypasses the resource.
 *
 * The rule is the SAME one the server applies, not a second copy of it: this
 * module resolves the target instance's own id through the shared decision
 * (src/lib/instance-identity-row.ts's decideInstanceAnswer — exactly one
 * Instance row is the identity), and stamps that. It never invents an id: no
 * row, several rows, or a failed read resolves to null, the defined
 * local-origin state the schema documents.
 *
 * Nothing here decides "which row SHOULD win" — a create stamps the local id
 * and ignores any value the record already carries.
 */
import {
  decideInstanceAnswer,
  readableInstanceRows,
  readInstanceRows,
  type InstanceIdentityRow,
  type OpsEndpoint,
} from "./instance-identity-row.js";
import { isValidAgentId } from "./agent-id-rule.js";
import {
  AGENT_HOME_STAMP_FIELD,
  isHomeLessAgentRow,
  isSyncOriginatedAgentRow,
} from "./agent-home-fields.js";

/** The operator command that back-fills the home on home-less rows that carry no federation-sync provenance. */
export const AGENT_HOME_STAMP_COMMAND = "flair agent stamp-home";

/** The remedy line doctor prints: the dry run is the bare command; only --apply writes. */
export const AGENT_HOME_STAMP_REMEDY = `${AGENT_HOME_STAMP_COMMAND} (dry run; add --apply to stamp)`;

/**
 * The request-body control field the remedy sends to the Agent resource
 * (flair#2472): a guarded home stamp. The resource reads it, applies the stamp
 * inside a FRESH OWNED transaction (the request's own transaction is detached for
 * that scope), and drops it before the write — it is a control field, not a
 * stored column. Re-exported so callers of this module keep
 * one import site; the implementations live in agent-home-fields.ts (the
 * dependency-free module the Agent resource imports directly).
 */
export {
  AGENT_HOME_FIELD,
  AGENT_HOME_STAMP_FIELD,
  AGENT_HOME_STAMP_PAUSE_POINT,
  AGENT_PRINCIPAL_WRITE_BACK_FIELD,
  AGENT_PRINCIPAL_WRITE_BACK_NO_ROW_ERROR,
  AGENT_PRINCIPAL_WRITE_BACK_PAUSE_POINT,
  isForeignAgentHome,
  isHomeLessAgentRow,
  isSyncOriginatedAgentRow,
  pickPrincipalWriteBackFields,
} from "./agent-home-fields.js";

/** The ops endpoint of an instance the CLI is about to write to. */
export function agentHomeEndpoint(
  opsPortOrUrl: number | string,
  adminUser: string,
  adminPass?: string,
  fetchImpl?: typeof fetch,
): OpsEndpoint {
  const opsUrl = typeof opsPortOrUrl === "number" ? `http://127.0.0.1:${opsPortOrUrl}` : opsPortOrUrl;
  return {
    opsUrl,
    // A caller without a pass sends no Authorization header — same posture as
    // the other ops-API seed helpers (loopback authorizeLocal).
    ...(adminPass !== undefined ? { credentials: { user: adminUser, pass: adminPass } } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

/**
 * The TARGET instance's own federation id — the value a create stamps as the new
 * Agent row's home. The ONE canonical Instance row, or null when there is not
 * exactly one (no row yet, several rows, or a read that did not happen). A null
 * is never a guess: it is the local-origin state, and it is what the server-side
 * localInstanceId() returns in the same situations.
 */
export async function resolveTargetInstanceId(endpoint: OpsEndpoint): Promise<string | null> {
  const identity = await resolveTargetInstanceIdentity(endpoint);
  return identity.kind === "one" ? identity.id : null;
}

/** What the target's Instance table says about its identity: one id, no row, several rows, or unread. */
export type TargetInstanceIdentity =
  | { kind: "one"; id: string }
  | { kind: "none" }
  | { kind: "multiple"; count: number }
  | { kind: "unreadable" };

/** The decision behind `resolveTargetInstanceId`, with the reason a null id is null. */
export async function resolveTargetInstanceIdentity(endpoint: OpsEndpoint): Promise<TargetInstanceIdentity> {
  let rows: InstanceIdentityRow[];
  try {
    rows = await readInstanceRows(endpoint);
  } catch (err) {
    // A read that FAILED is not a read that found no row. Stamp nothing (the
    // local-origin state) rather than inventing an id; the row still gets a home
    // on a later re-run once the table is readable.
    console.error("Agent home: the target instance's Instance row could not be read, so the new row's home is left empty", {
      opsUrl: endpoint.opsUrl,
      err,
    });
    return { kind: "unreadable" };
  }
  const decision = decideInstanceAnswer(rows);
  if (decision.kind === "answer") return { kind: "one", id: decision.row.id };
  if (decision.kind === "refuse-multiple") return { kind: "multiple", count: decision.rows.length };
  return { kind: "none" };
}

/**
 * Every `flair.Instance` row an HTTP endpoint reports, read through its REST
 * `/Instance/` resource with admin Basic auth. Throws on a non-2xx, a body that
 * is not a row list, or an entry without a usable id — a read that established
 * nothing, never a read of zero rows (the same rule `readInstanceRows` follows
 * on the ops side). Uses the ONE reader (`readableInstanceRows`).
 */
export async function readInstanceRowsViaHttp(
  httpBase: string,
  adminUser: string,
  adminPass: string,
  fetchImpl?: typeof fetch,
): Promise<InstanceIdentityRow[]> {
  const fetchFn = fetchImpl ?? fetch;
  const res = await fetchFn(`${httpBase.replace(/\/+$/, "")}/Instance/`, {
    headers: { Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GET /Instance/ answered HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : null;
  if (rows === null) throw new Error("GET /Instance/ answered a body that is not a row list");
  return readableInstanceRows(rows);
}

/**
 * The instance identity an HTTP endpoint reports (flair#2483), decided by the
 * SAME rule as the ops-API read: exactly one nameable `flair.Instance` row is an
 * identity; no row, several rows, or a read that did not happen is not.
 */
export async function readHttpInstanceIdentity(
  httpBase: string,
  adminUser: string,
  adminPass: string,
  fetchImpl?: typeof fetch,
): Promise<TargetInstanceIdentity> {
  let rows: InstanceIdentityRow[];
  try {
    rows = await readInstanceRowsViaHttp(httpBase, adminUser, adminPass, fetchImpl);
  } catch {
    return { kind: "unreadable" };
  }
  const decision = decideInstanceAnswer(rows);
  if (decision.kind === "answer") return { kind: "one", id: decision.row.id };
  if (decision.kind === "refuse-multiple") return { kind: "multiple", count: decision.rows.length };
  return { kind: "none" };
}

/** Whether two endpoints report the same instance: one id, two different ids, or not establishable (flair#2483). */
export type ProbedPairIdentity =
  | { kind: "same"; id: string }
  | { kind: "different"; httpId: string; opsId: string }
  | { kind: "unestablished"; detail: string };

/** A one-line description of a single endpoint's identity state, for a refusal reason. */
function describeIdentityState(id: TargetInstanceIdentity): string {
  switch (id.kind) {
    case "one": return "one instance identity";
    case "none": return "no instance identity";
    case "multiple": return `${id.count} instance identity rows`;
    case "unreadable": return "an instance identity it could not read";
  }
}

/**
 * The instance-identity comparison doctor adds to its configuration check
 * before the roster and home reads (flair#2483): the identity the probed HTTP
 * port reports against the identity the candidate ops endpoint reports. Only
 * two SINGLE, EQUAL ids are `same`. Two different single ids are `different`.
 * Anything else — no row (a fresh install), several rows, or an unreadable read
 * on either side — is `unestablished`. The caller refuses only on `different`;
 * the configuration check (src/lib/local-instance-pair.ts) decides the rest.
 */
export function decideProbedPairIdentity(http: TargetInstanceIdentity, ops: TargetInstanceIdentity): ProbedPairIdentity {
  if (http.kind === "one" && ops.kind === "one") {
    return http.id === ops.id
      ? { kind: "same", id: http.id }
      : { kind: "different", httpId: http.id, opsId: ops.id };
  }
  return {
    kind: "unestablished",
    detail: `the probed HTTP port reports ${describeIdentityState(http)}, the ops endpoint reports ${describeIdentityState(ops)}`,
  };
}

/**
 * Stamp an Agent create record with the creating instance's id, ignoring any
 * value the record already carries. `home` of null writes an explicit null (the
 * local-origin state), never a stale body value.
 */
export function stampAgentHome(record: Record<string, unknown>, home: string | null): void {
  record.originatorInstanceId = home;
}

/**
 * Read every Agent row's home decision fields through the ops API. The read asks
 * for the full row (`get_attributes: ["*"]`) rather than a projection: the
 * receiver bookkeeping columns (`_syncedFrom`, `_originatorInstanceId`) are not
 * in the Agent schema, so a `SELECT` of them is not a safe read, but a full row
 * returns them where the federation merge wrote them. Returns null on a read
 * that failed or whose body was not a row list — a failed read is never "no
 * rows".
 */
export async function readAgentHomeRows(args: {
  opsUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Array<Record<string, unknown>> | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(args.opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({
        operation: "search_by_value",
        database: "flair",
        table: "Agent",
        search_attribute: "id",
        search_value: "*",
        get_attributes: ["*"],
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : null;
    return rows as Array<Record<string, unknown>> | null;
  } catch {
    return null;
  }
}

/** A row's id as a string, or null when it carries no usable id. */
export function agentRowId(row: { id?: unknown }): string | null {
  return typeof row?.id === "string" && row.id.length > 0 ? row.id : null;
}

/** The home decision over a full Agent row read: what is home-less, and what the remedy may stamp. */
export interface AgentHomePlan {
  /** Every Agent row with no home, sorted. */
  homeLess: string[];
  /** The home-less rows with no sync provenance — the remedy may stamp the local id on these. */
  stampable: string[];
  /** The home-less rows that arrived through a federation merge — listed only, never stamped. */
  sync: string[];
}

/**
 * Split the Agent roster into home-less rows and, of those, the ones the remedy
 * may stamp: a home-less row with no sync provenance. A row carrying sync
 * provenance arrived through federation and is listed only.
 *
 * PURE. `localInstanceId` is not used to decide the split — a null id only means
 * the remedy has nothing to write.
 */
export function planAgentHomeStamps(
  rows: Array<Record<string, unknown>>,
  _localInstanceId: string | null,
): AgentHomePlan {
  const homeLessRows = (Array.isArray(rows) ? rows : []).filter(
    (row) => row != null && typeof row === "object" && isHomeLessAgentRow(row),
  );
  const homeLess = homeLessRows.map(agentRowId).filter((id): id is string => id !== null).sort();
  const sync = homeLessRows
    .filter((row) => isSyncOriginatedAgentRow(row))
    .map(agentRowId)
    .filter((id): id is string => id !== null)
    .sort();
  const syncSet = new Set(sync);
  return { homeLess, stampable: homeLess.filter((id) => !syncSet.has(id)), sync };
}

/** The named error for an ops-API write that would change a stored home. */
export const AGENT_HOME_IMMUTABLE_ERROR = "originator_instance_immutable";

/**
 * The refusal for a write that would CHANGE an Agent row's stored home
 * (flair#2433). The home is immutable after create: a later write may omit it
 * (the stored value stands) or restate it, but may never replace it.
 */
export function agentHomeChangeRefusal(id: string, stored: string, next: string | null): string {
  return (
    `${AGENT_HOME_IMMUTABLE_ERROR}: agent '${id}' already has a home instance (${stored}); ` +
    `refusing to change it to ${next === null ? "(none)" : next}. ` +
    "The home is immutable after create."
  );
}

/** The outcome of reading one Agent row's stored home. */
export type StoredAgentHomeRead =
  | { state: "absent" }
  | { state: "found"; home: string | null }
  | { state: "unreadable"; reason: string };

/**
 * Read one Agent row's stored home (`originatorInstanceId`) through the ops API.
 * An unreadable read is its OWN state, never "absent": a write that would decide
 * on it must refuse rather than treat a failed read as a row with no home.
 */
export async function readStoredAgentHome(args: {
  opsUrl: string;
  authHeader: string;
  id: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<StoredAgentHomeRead> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(args.opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({
        operation: "search_by_id",
        database: "flair",
        table: "Agent",
        ids: [args.id],
        get_attributes: ["id", "originatorInstanceId"],
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
    });
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { state: "unreadable", reason: `HTTP ${res.status}` };
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  const rows = Array.isArray(data) ? data : Array.isArray((data as any)?.results) ? (data as any).results : null;
  if (rows === null) return { state: "unreadable", reason: "the read answered 200 with no row list" };
  if (rows.length === 0) return { state: "absent" };
  const home = (rows[0] as Record<string, unknown>)?.originatorInstanceId;
  return { state: "found", home: typeof home === "string" && home.length > 0 ? home : null };
}

/** What a create-or-upsert Agent write may do, given the row already stored. */
export type AgentHomeWritePlan =
  | { refuse: true; message: string }
  | { refuse: false; stamp: boolean; home: string | null };

/**
 * Decide whether an ops-API Agent create/upsert may proceed, given the stored
 * row that already carries this id (`existing`) and the home this instance would
 * stamp (`home`, from resolveTargetInstanceId). PURE.
 *
 * Refuses — with a named error — when a non-null `home` differs from the stored
 * one (a null `home` cannot change it, since no home is written over a found row), and
 * when the stored row could not be read (an unreadable read is not "no home").
 * Otherwise `stamp` is true only for an absent row (a create); over a found row
 * the write must omit the home so the stored value, null or not, stands.
 */
export function planAgentHomeWrite(
  existing: StoredAgentHomeRead,
  home: string | null,
  id: string,
): AgentHomeWritePlan {
  if (existing.state === "unreadable") {
    return {
      refuse: true,
      message: `could not read agent '${id}' before writing it (${existing.reason}); no change was made.`,
    };
  }
  if (existing.state === "found" && existing.home !== null && home !== null && existing.home !== home) {
    return { refuse: true, message: agentHomeChangeRefusal(id, existing.home, home) };
  }
  return { refuse: false, stamp: existing.state === "absent", home };
}

/** What `flair agent stamp-home` did (or would do). */
export interface AgentHomeStampResult {
  ok: boolean;
  reason?: "roster-unreadable" | "no-canonical-id";
  plan: AgentHomePlan;
  /** The ids whose home was stamped and read back (empty on a dry run). */
  stamped: string[];
  /** The planned ids not counted as stamped, excluding `vanished`. */
  skipped: string[];
  /** The planned ids whose row was gone when re-read just before its write. */
  vanished: string[];
}

/** The lines `flair agent stamp-home --apply` prints for the rows it left unwritten. */
export function stampLeftoverLines(result: Pick<AgentHomeStampResult, "skipped" | "vanished">): string[] {
  return [
    ...result.skipped.map((id) => `     not counted as stamped: ${id}`),
    ...result.vanished.map((id) => `     skipped (no longer present): ${id}`),
  ];
}

/** One Agent row in full (null when absent, "unreadable" when the read failed). */
async function readAgentRowForStamp(args: {
  opsUrl: string;
  authHeader: string;
  id: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<Record<string, unknown> | null | "unreadable"> {
  try {
    const res = await args.fetchImpl(args.opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({ operation: "search_by_id", database: "flair", table: "Agent", ids: [args.id], get_attributes: ["*"] }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    if (!res.ok) return "unreadable";
    const data = await res.json();
    const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : null;
    if (rows === null) return "unreadable";
    return rows.length > 0 && rows[0] && typeof rows[0] === "object" ? (rows[0] as Record<string, unknown>) : null;
  } catch {
    return "unreadable";
  }
}

/**
 * Back-fill the home on home-less Agent rows with no sync provenance
 * (flair#2433, flair#2472). Reads the roster, plans the stamps, and — with
 * `apply` — asks the Agent resource (a REST PATCH, `httpUrl`) to stamp each
 * stampable row, then reads it back before counting it.
 *
 * The stamp's decision is made INSIDE the resource, in a FRESH OWNED transaction
 * (the request's own transaction is detached for that scope): the resource reads
 * the row there and stamps only when it is still home-less and carries no
 * federation-sync provenance, writing the id the CURRENT `Instance` table names
 * (failure to confirm a single canonical Instance row is refused by name); it then
 * re-reads the committed row and aborts if that read sees a home, provenance, or
 * no row. The CLI's own read is a plan/report, never the write's authority: a
 * row the resource's reads see gain a home or provenance is left alone, and a
 * row they find gone is reported vanished (a stamp never creates). A change
 * committed after the resource's confirmation read and before its commit is not
 * seen (flair#2478). A row is counted `stamped` only when the resource reports
 * that it applied the stamp (`stamped: true`) AND the read-back shows this
 * instance's home with no provenance.
 *
 * `localInstanceId` is the value resolved through the one shared rule; a null
 * ends the run with no write (there is nothing to stamp).
 */
export async function runAgentHomeStamp(args: {
  opsUrl: string;
  httpUrl: string;
  authHeader: string;
  localInstanceId: string | null;
  apply: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AgentHomeStampResult> {
  const empty: AgentHomePlan = { homeLess: [], stampable: [], sync: [] };
  const rows = await readAgentHomeRows({
    opsUrl: args.opsUrl,
    authHeader: args.authHeader,
    fetchImpl: args.fetchImpl,
    timeoutMs: args.timeoutMs,
  });
  if (rows === null) return { ok: false, reason: "roster-unreadable", plan: empty, stamped: [], skipped: [], vanished: [] };
  const plan = planAgentHomeStamps(rows, args.localInstanceId);
  if (!args.apply) return { ok: true, plan, stamped: [], skipped: [], vanished: [] };
  if (args.localInstanceId === null) return { ok: false, reason: "no-canonical-id", plan, stamped: [], skipped: [], vanished: [] };
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? 10_000;
  const stampUrl = `${args.httpUrl.replace(/\/$/, "")}/Agent/`;
  const stamped: string[] = [];
  const skipped: string[] = [];
  const vanished: string[] = [];
  for (const id of plan.stampable) {
    // The shared agent-ID rule owns an id outside it — the doctor's Agent-ID
    // check reports such a row. A home stamp is not the place to rewrite it.
    if (!isValidAgentId(id)) continue;
    const current = await readAgentRowForStamp({ opsUrl: args.opsUrl, authHeader: args.authHeader, id, fetchImpl, timeoutMs });
    if (current === "unreadable") {
      throw new Error(`Could not re-read agent '${id}' before stamping it; no change was made to it.`);
    }
    if (current === null) {
      vanished.push(id);
      continue;
    }
    if (isSyncOriginatedAgentRow(current)) {
      skipped.push(id);
      continue;
    }
    if (!isHomeLessAgentRow(current)) {
      // Gained a home since the plan read. Listed, never overwritten.
      skipped.push(id);
      continue;
    }
    // The guarded write: the Agent resource re-checks home-lessness and
    // provenance inside a fresh owned transaction and stamps the id the current
    // Instance table names. A 404 is reported as vanished.
    const res = await fetchImpl(`${stampUrl}${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({ id, originatorInstanceId: args.localInstanceId, [AGENT_HOME_STAMP_FIELD]: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
      vanished.push(id);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to stamp the home on agent '${id}' (${res.status}): ${text}`);
    }
    // The resource confirms whether IT applied the stamp (`stamped: true`), and
    // the decision is made inside its fresh owned transaction. A read-back that
    // merely shows this instance's home is NOT that confirmation: another writer
    // may have set the same home, or a later merge may own the row. Count a row
    // stamped only when the resource applied it AND the read-back still shows
    // this instance's home with no provenance.
    const body = (await res.json().catch(() => null)) as { stamped?: unknown } | null;
    const applied = body?.stamped === true;
    const back = await readAgentRowForStamp({ opsUrl: args.opsUrl, authHeader: args.authHeader, id, fetchImpl, timeoutMs });
    if (back === "unreadable") {
      throw new Error(`The home stamp for agent '${id}' was not confirmed (the read-back failed).`);
    }
    if (applied && back !== null && !isSyncOriginatedAgentRow(back) && back.originatorInstanceId === args.localInstanceId) {
      stamped.push(id);
    } else {
      skipped.push(id);
    }
  }
  return { ok: true, plan, stamped, skipped, vanished };
}
