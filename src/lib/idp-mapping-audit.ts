/**
 * idp-mapping-audit.ts — `flair doctor`'s read-only check: active IdP mapping
 * rows (Credential rows of kind "idp") and what the audit log shows about who
 * wrote their mapping.
 *
 * Through the Credential resource, only an administrator or the server creates
 * an IdP mapping, changes its kind or identity fields, or reactivates it; a
 * non-admin agent may relabel, revoke and delete its own
 * (src/lib/idp-mapping-rule.ts). This check lists, for an operator to review,
 * the active mappings whose retained audit history shows a non-admin agent's
 * mapping write, and the active mappings whose history cannot show who wrote
 * them. It rewrites and deletes nothing.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Only mappings in effect are checked: rows the resolvers use, whose status is
 * exactly "active" and that name a principal (src/lib/credential-status-rule.ts).
 * A revoked row maps nobody, so revoking a reported mapping clears its finding.
 *
 * ── Attribution ─────────────────────────────────────────────────────────────
 * The Credential table records no writer. Harper's audit log does: each entry
 * names the Harper user that made the write. A verified non-admin agent's REST
 * write runs as the shared least-privilege user `flair-agent`
 * (resources/auth-middleware.ts). An admin agent, the operations API
 * (`flair mcp enable`, `flair principal link`) and the server's own
 * provisioning and use stamps run as another user.
 *
 * `read_audit_log` returns each entry with the whole row as of that entry,
 * which Harper reconstructs for a partial write; it carries no field that
 * says whether the row existed before the write (operation, user, timestamp,
 * ids and the row are all it returns). So the change an entry made is the
 * difference from the entry before it, and the first retained entry's change
 * is known only when that entry is the row's creation.
 *
 * A row's history starts over at either of two points:
 *   - its recorded creation: an `insert` (Harper writes one only for a new
 *     row); a write after a recorded delete; or a creation stamp, a first
 *     retained `upsert` or `put` by a user other than `flair-agent` whose row
 *     carries a `createdAt` within CREATION_STAMP_TOLERANCE_MS of the entry and
 *     no `lastUsedAt` other than that same `createdAt`;
 *   - an administrator's review re-stamp, the remedy this check prints for a
 *     row it reports: an operations-API `update` by a user other than
 *     `flair-agent` that, by the retained row before it, changed `createdAt` to
 *     a whole-second UTC time within the tolerance of the entry. Without a
 *     retained prior row a change cannot be shown, so an `update` that is the
 *     first retained entry is not a re-stamp, and an `update` that leaves
 *     `createdAt` as it was never is. The printed remedy writes two updates, a
 *     fixed past time and then the current time, so the second always has a
 *     retained prior row that shows the change. Harper rebuilds a partial
 *     write's row from the current row, so a field the write did not set can
 *     show a later write's value; the whole-second form tells the printed
 *     re-stamp from the millisecond times every other writer stamps.
 *
 * A creation stamp relies on `createdAt`. Every path that can create a mapping
 * sets it: the linker (`flair mcp enable`, `flair principal link`) to its
 * host's time at the mapping write, the /mcp and XAA JIT provisioners to the
 * server's time (XAA also sets `lastUsedAt` to that same value), and the
 * Credential resource's POST and PUT to the body's value or the server's time,
 * a write only an administrator may make for a mapping. A linker run on a host
 * whose clock differs from the server's by more than the tolerance, or a POST
 * or PUT body carrying an older `createdAt`, leaves its mapping unattributed
 * until it is re-stamped. A non-admin agent can change `createdAt` on its own
 * row, but that write is recorded as `flair-agent`, and no entry by that user
 * ever starts a history over. The server's use stamps on an existing row do
 * not read as a creation: the /mcp one is a `patch`, and the XAA one keeps the
 * stored `createdAt` and sets a new `lastUsedAt`. An `update` is written only
 * by the operations API, never by the server.
 *
 * Each active row is one of:
 *   - non-admin write: since the row's history last started over, an entry by
 *     `flair-agent` whose prior row is known created the row as a mapping, or
 *     changed it in a way the rule reserves for administrators and the server;
 *   - unattributed: no such entry, and the history does not start at a
 *     recorded creation or a review re-stamp (no retained entry, a first
 *     retained entry that is neither, or an entry with no row image), so a
 *     write the log does not hold may have set the mapping;
 *   - neither: the history starts at a recorded creation or a review re-stamp,
 *     with no such entry since.
 *
 * ── What it cannot tell ─────────────────────────────────────────────────────
 *   - Audit entries expire after `logging.auditRetention` (3 days by default),
 *     and a node filled by a cluster base copy holds no entries for the copied
 *     rows (harper#2212). Such rows are unattributed until an administrator
 *     re-stamps or revokes them.
 *   - A write made before the `flair-agent` user was provisioned ran as the
 *     admin user, so the log records it as an administrator's.
 *   - With the audit log off, nothing can be attributed; the check says so.
 */
import { credentialMapsPrincipal } from "./credential-status-rule.js";
import { IDP_KIND, isIdpMappingChange, namesIdpKind } from "./idp-mapping-rule.js";

/** The Harper user a verified non-admin agent's REST writes run as (src/cli.ts FLAIR_AGENT_USERNAME). */
export const NON_ADMIN_AGENT_HARPER_USER = "flair-agent";

/** The audit ids read per `read_audit_log` call. */
const AUDIT_BATCH = 100;

export interface IdpMappingRow {
  id: string;
  principalId?: unknown;
  idpProvider?: unknown;
  status?: unknown;
}

export interface CredentialAuditEntry {
  operation?: unknown;
  user_name?: unknown;
  timestamp?: unknown;
  records?: unknown;
}

export type CredentialAuditRead =
  | { kind: "ok"; byId: Record<string, CredentialAuditEntry[]> }
  | { kind: "disabled" }
  | { kind: "failed" };

/** One mapping a non-admin agent wrote, as listed by the finding. */
export interface NonAdminIdpMapping {
  id: string;
  principalId: string;
  idpProvider: string;
}

export interface IdpMappingWriterFinding {
  /** Active rows whose retained audit history shows a non-admin agent's mapping write. */
  nonAdmin: NonAdminIdpMapping[];
  /** Active rows whose retained history does not show their creation: who wrote their mapping cannot be told. */
  unattributed: string[];
  /** The active rows examined. */
  active: number;
  /** The idp rows stored, active or not. */
  total: number;
}

/** What a row's retained audit history shows. See the header. */
export type IdpMappingHistory = "non-admin-write" | "unattributed" | "no-non-admin-write";

async function opsPost(args: { opsUrl: string; authHeader: string; fetchImpl?: typeof fetch; timeoutMs?: number }, body: unknown): Promise<Response> {
  return (args.fetchImpl ?? fetch)(args.opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: args.authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
  });
}

/**
 * Read every Credential row of kind "idp" through the operations API. Returns
 * the rows, or null when the read failed or its body was not a row list — a
 * failed read is never "no rows".
 */
export async function readIdpMappingRows(args: {
  opsUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<IdpMappingRow[] | null> {
  try {
    const res = await opsPost(args, {
      operation: "search_by_value", database: "flair", table: "Credential",
      search_attribute: "kind", search_type: "equals", search_value: IDP_KIND,
      get_attributes: ["id", "kind", "principalId", "idpProvider", "status"],
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data.filter((row) => row && typeof row.id === "string" && namesIdpKind(row.kind)) as IdpMappingRow[];
  } catch {
    return null;
  }
}

/**
 * Read the Credential audit entries for `ids` through the operations API
 * (`read_audit_log`, by primary key). "disabled" when the instance answers 400
 * (the audit log is off); "failed" on any other failure.
 */
export async function readCredentialAudit(args: {
  opsUrl: string;
  authHeader: string;
  ids: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<CredentialAuditRead> {
  const byId: Record<string, CredentialAuditEntry[]> = {};
  try {
    for (let i = 0; i < args.ids.length; i += AUDIT_BATCH) {
      const ids = args.ids.slice(i, i + AUDIT_BATCH);
      const res = await opsPost(args, {
        operation: "read_audit_log", schema: "flair", table: "Credential",
        search_type: "hash_value", search_values: ids,
      });
      if (res.status === 400) return { kind: "disabled" };
      if (!res.ok) return { kind: "failed" };
      const data = await res.json();
      if (data == null || typeof data !== "object" || Array.isArray(data)) return { kind: "failed" };
      for (const id of ids) {
        const entries = (data as Record<string, unknown>)[id];
        byId[id] = Array.isArray(entries) ? (entries as CredentialAuditEntry[]) : [];
      }
    }
  } catch {
    return { kind: "failed" };
  }
  return { kind: "ok", byId };
}

/** The one audit operation Harper writes only for a row that did not exist. */
const CREATING_OPERATION = "insert";

/** Whole-row writes a first retained entry may be, to be taken as a creation stamp. */
const STAMP_OPERATIONS = new Set(["upsert", "put"]);

/** The operations-API operation an administrator's review re-stamp is. The server never records it. */
const RESTAMP_OPERATION = "update";

/** The form the printed re-stamp writes: a whole-second UTC time (`date -u +%Y-%m-%dT%H:%M:%SZ`). */
const RESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The fixed past time the printed re-stamp writes first, so its second update shows a change. */
export const RESTAMP_PRIOR_CREATED_AT = "1970-01-01T00:00:00Z";

/**
 * How far a creation stamp's `createdAt` may be from its entry's timestamp.
 * The JIT provisioners and the Credential resource stamp the server's own
 * time (within milliseconds of the entry); the linker stamps its own clock at
 * the start of a run, a few reads before its write, possibly on another host.
 */
export const CREATION_STAMP_TOLERANCE_MS = 60_000;

/** The row image an entry carries for `id`: the whole row as of that entry. */
function entryImage(entry: CredentialAuditEntry, id: string): Record<string, unknown> | null {
  const records = Array.isArray(entry.records) ? entry.records : [];
  const match = records.find((r: any) => r && typeof r === "object" && (r.id === undefined || r.id === id));
  return match && typeof match === "object" ? (match as Record<string, unknown>) : null;
}

/** The prior row is not in the retained history. */
const NOT_RETAINED = Symbol("not-retained");

/** Is the row's `createdAt` within the tolerance of the entry's timestamp? */
function createdAtMatchesEntry(entry: CredentialAuditEntry, image: Record<string, unknown>): boolean {
  const created = typeof image.createdAt === "string" ? Date.parse(image.createdAt) : Number.NaN;
  const at = Number(entry.timestamp);
  return Number.isFinite(created) && Number.isFinite(at) && Math.abs(at - created) <= CREATION_STAMP_TOLERANCE_MS;
}

/**
 * Is this entry, whose prior row is not retained, a creation stamp by an
 * administrator or the server? See the header for why each condition holds.
 */
function isCreationStamp(entry: CredentialAuditEntry, image: Record<string, unknown>, agentUser: string): boolean {
  if (entry.user_name === agentUser) return false;
  if (!STAMP_OPERATIONS.has(String(entry.operation ?? ""))) return false;
  if (!createdAtMatchesEntry(entry, image)) return false;
  return image.lastUsedAt == null || image.lastUsedAt === image.createdAt;
}

/**
 * Is this entry an administrator's review re-stamp? Only when the retained
 * row before it shows that it changed `createdAt` to a whole-second UTC time
 * within the tolerance of the entry (see the header).
 */
function isReviewRestamp(
  entry: CredentialAuditEntry,
  image: Record<string, unknown>,
  prior: Record<string, unknown> | null | typeof NOT_RETAINED,
  agentUser: string,
): boolean {
  if (entry.user_name === agentUser || entry.operation !== RESTAMP_OPERATION) return false;
  if (prior === null || prior === NOT_RETAINED) return false;
  const stamped = image.createdAt;
  if (typeof stamped !== "string" || !RESTAMP_FORMAT.test(stamped) || stamped === prior.createdAt) return false;
  return createdAtMatchesEntry(entry, image);
}

/**
 * What the retained audit history of `id` shows (see the header). Entries are
 * replayed in timestamp order. A recorded creation or a review re-stamp starts
 * the row's history over: what came before it no longer decides the row as it
 * stands. Any other write is
 * judged against the row before it only when that row is known; a write whose
 * prior row is not retained is never judged, whoever made it, and makes the
 * row unattributed instead.
 */
export function classifyIdpMappingHistory(
  id: string,
  entries: CredentialAuditEntry[],
  agentUser = NON_ADMIN_AGENT_HARPER_USER,
): IdpMappingHistory {
  const ordered = [...entries].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
  let prior: Record<string, unknown> | null | typeof NOT_RETAINED = NOT_RETAINED;
  let creationShown = true;
  let nonAdminWrite = false;
  for (const entry of ordered) {
    const operation = String(entry.operation ?? "");
    if (operation === "delete") {
      prior = null;
      continue;
    }
    const image = entryImage(entry, id);
    if (!image) {
      // No row image: neither this write nor the next one can be judged.
      creationShown = false;
      prior = NOT_RETAINED;
      continue;
    }
    const startsOver =
      operation === CREATING_OPERATION ||
      prior === null ||
      (prior === NOT_RETAINED && isCreationStamp(entry, image, agentUser)) ||
      isReviewRestamp(entry, image, prior, agentUser);
    if (startsOver) {
      creationShown = true;
      nonAdminWrite = entry.user_name === agentUser && isIdpMappingChange(null, image);
    } else if (prior === NOT_RETAINED) {
      creationShown = false;
    } else if (entry.user_name === agentUser && isIdpMappingChange(prior, image)) {
      nonAdminWrite = true;
    }
    prior = image;
  }
  if (nonAdminWrite) return "non-admin-write";
  // No entry, or a history that ends in a delete although the row is stored.
  if (prior === NOT_RETAINED || prior === null) creationShown = false;
  return creationShown ? "no-non-admin-write" : "unattributed";
}

/**
 * The finding: every active idp row whose retained history shows a non-admin
 * agent's mapping write, and every active row whose history cannot show who
 * wrote its mapping. PURE — it reports; nothing is rewritten.
 */
export function describeIdpMappingWriters(
  rows: IdpMappingRow[],
  auditById: Record<string, CredentialAuditEntry[]>,
  agentUser = NON_ADMIN_AGENT_HARPER_USER,
): IdpMappingWriterFinding {
  const nonAdmin: NonAdminIdpMapping[] = [];
  const unattributed: string[] = [];
  const active = rows.filter((row) => credentialMapsPrincipal(row));
  for (const row of active) {
    const history = classifyIdpMappingHistory(row.id, auditById[row.id] ?? [], agentUser);
    if (history === "non-admin-write") {
      nonAdmin.push({ id: row.id, principalId: String(row.principalId ?? ""), idpProvider: String(row.idpProvider ?? "") });
    } else if (history === "unattributed") {
      unattributed.push(row.id);
    }
  }
  nonAdmin.sort((a, b) => a.id.localeCompare(b.id));
  unattributed.sort();
  return { nonAdmin, unattributed, active: active.length, total: rows.length };
}

/** The most unattributed row ids one report line names. */
const UNATTRIBUTED_LISTED = 10;

/** Where the printed remedy commands send their operations-API calls. */
export interface IdpMappingRemedyTarget {
  /** The operations API, e.g. http://127.0.0.1:9925/ */
  opsUrl: string;
  /** The admin user; curl prompts for its password, so none is printed or put in argv. */
  adminUser: string;
}

/** Characters a row id, user or URL may use to be printed inside a shell command. */
const SHELL_SAFE = /^[A-Za-z0-9_.:@\/-]+$/;

/** The current UTC time in whole seconds, as the shell computes it when the command runs (bash, zsh, fish 3.4+). */
const SHELL_NOW = `'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'`;

/** One operations-API call as a curl command; `body` is JSON with no single quote. */
function opsCommand(target: IdpMappingRemedyTarget, body: string): string {
  return `curl -su ${target.adminUser} -H 'Content-Type: application/json' ${target.opsUrl} -d '${body}'`;
}

/**
 * The review, re-stamp and revoke commands for `ids`, or null when none can be
 * printed safely. The re-stamp is two updates joined by `&&`: createdAt to
 * RESTAMP_PRIOR_CREATED_AT, then to the current time, so the retained row
 * before the second shows that it changed createdAt (see the header).
 */
export function idpMappingRemedyCommands(
  ids: string[],
  target: IdpMappingRemedyTarget,
): { review: string; restamp: string; revoke: string; omitted: number } | null {
  if (!SHELL_SAFE.test(target.adminUser) || !SHELL_SAFE.test(target.opsUrl)) return null;
  const safe = ids.filter((id) => SHELL_SAFE.test(id));
  if (safe.length === 0) return null;
  const table = `"database":"flair","table":"Credential"`;
  const review = `{"operation":"search_by_id",${table},"get_attributes":["*"],"ids":[` +
    safe.map((id) => `"${id}"`).join(",") + "]}";
  const restampTo = (createdAt: string) => `{"operation":"update",${table},"records":[` +
    safe.map((id) => `{"id":"${id}","createdAt":"${createdAt}"}`).join(",") + "]}";
  const revoke = `{"operation":"update",${table},"records":[` +
    safe.map((id) => `{"id":"${id}","status":"revoked"}`).join(",") + "]}";
  return {
    review: opsCommand(target, review),
    restamp: `${opsCommand(target, restampTo(RESTAMP_PRIOR_CREATED_AT))} && ${opsCommand(target, restampTo(SHELL_NOW))}`,
    revoke: opsCommand(target, revoke),
    omitted: ids.length - safe.length,
  };
}

export interface IdpMappingWriterReport {
  /** Each finding, a counted issue: its warning line and its remedy lines. Empty when there is none. */
  findings: { warn: string; fix: string[] }[];
  /** The line for a check with no finding; null when there is a finding. */
  clear: string | null;
  /** The caveat on every attribution the audit log makes. */
  note: string;
}

/**
 * The remedy lines shared by both findings: review, keep (re-stamp) and drop
 * (revoke). When no command can be printed safely (every id, the admin user
 * or the URL uses other characters), the lines name the operations instead.
 */
function remedyLines(ids: string[], target: IdpMappingRemedyTarget, keepFirst: boolean): string[] {
  const commands = idpMappingRemedyCommands(ids, target);
  if (!commands) {
    return ["these row ids, the admin user or the operations-API URL use characters doctor does not put in a shell " +
      "command, so no command is printed. As an administrator, read each row through the operations API; to keep one " +
      `you reviewed, send two operations-API updates of its createdAt, first to ${RESTAMP_PRIOR_CREATED_AT} and then ` +
      "to the current UTC time in whole seconds; to drop one, update its status to revoked. Doctor changed nothing."];
  }
  const keep = "keep a mapping you reviewed: re-stamp it as an administrator with two updates of its createdAt, which " +
    `the next run attributes to that review: ${commands.restamp}`;
  const drop = `drop a mapping: revoke it; a revoked row maps nobody and is not checked: ${commands.revoke}`;
  return [
    `review the rows (curl prompts for the admin password for each request; this prints each row): ${commands.review}`,
    ...(keepFirst ? [keep, drop] : [drop, keep]),
    "Doctor changed nothing. Edit each command to the rows you choose" +
      (commands.omitted > 0 ? `; ${commands.omitted} row id(s) with other characters are left out of the commands.` : "."),
  ];
}

/**
 * The finding's report lines. A row that cannot be attributed is a finding,
 * never a clear result. Each finding prints the commands that clear it for the
 * rows whose ids can be printed in a shell command, and names the operations
 * when none can.
 */
export function idpMappingWriterReport(finding: IdpMappingWriterFinding, target: IdpMappingRemedyTarget): IdpMappingWriterReport {
  const findings: { warn: string; fix: string[] }[] = [];
  if (finding.nonAdmin.length > 0) {
    findings.push({
      warn: `${finding.nonAdmin.length} IdP mapping row(s) written by a non-admin agent (from the audit log): ` +
        finding.nonAdmin.map((m) => `${m.id} (principal '${m.principalId}', provider '${m.idpProvider}')`).join(", "),
      fix: remedyLines(finding.nonAdmin.map((m) => m.id), target, false),
    });
  }
  if (finding.unattributed.length > 0) {
    const listed = finding.unattributed.slice(0, UNATTRIBUTED_LISTED);
    const more = finding.unattributed.length - listed.length;
    findings.push({
      warn: `${finding.unattributed.length} IdP mapping row(s) cannot be attributed: their retained audit history ` +
        "starts at neither a recorded creation nor an administrator's review re-stamp, so whether a non-admin agent " +
        "wrote their mapping cannot be told: " +
        listed.join(", ") + (more > 0 ? ` and ${more} more` : ""),
      fix: remedyLines(listed, target, true),
    });
  }
  return {
    findings,
    clear: findings.length > 0 ? null : finding.active === 0
      ? `No active IdP mapping rows (${finding.total} stored, none active).`
      : `No active IdP mapping row's audit history shows a non-admin agent's mapping write, and each row's history ` +
        `starts at its recorded creation or at an administrator's review re-stamp (${finding.active} active of ` +
        `${finding.total} stored).`,
    note: "A write made before the flair-agent Harper user existed is recorded as an administrator's.",
  };
}
