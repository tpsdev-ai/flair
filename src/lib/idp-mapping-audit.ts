/**
 * idp-mapping-audit.ts — `flair doctor`'s read-only check: IdP mapping rows
 * (Credential rows of kind "idp") written by a non-admin agent, from the audit
 * log.
 *
 * An IdP mapping is written only by an administrator or by the server
 * (src/lib/idp-mapping-rule.ts). This check lists, for an operator to review,
 * the idp rows whose writes the audit log attributes to a non-admin agent. It
 * rewrites and deletes nothing.
 *
 * ── Attribution ─────────────────────────────────────────────────────────────
 * The Credential table records no writer. Harper's audit log does: each entry
 * names the Harper user that made the write and carries the record image. A
 * verified non-admin agent's REST write runs as the shared least-privilege
 * user `flair-agent` (resources/auth-middleware.ts). An admin agent, the
 * operations API (`flair mcp enable`, `flair principal link`) and the server's
 * own provisioning run as another user. So a row is listed when a retained
 * audit entry by `flair-agent` created it as a mapping, or changed its kind,
 * principalId, idpProvider or idpSubject, or set a status other than revoked.
 *
 * ── What it cannot tell ─────────────────────────────────────────────────────
 *   - A row with no retained audit entry: the log keeps
 *     `logging.auditRetention` (3 days by default), and a node filled by a
 *     cluster base copy holds no entries for the copied rows (harper#2212).
 *     Such rows are reported as unattributed, never as clean.
 *   - A write made before the `flair-agent` user was provisioned: every
 *     verified agent then ran as the admin user, so its writes read as an
 *     administrator's.
 *   - With the audit log off, nothing can be attributed; the check says so.
 */
import { IDP_KIND, IDP_MAPPING_IDENTITY_FIELDS, IDP_SELF_SERVICE_STATUS, isIdpMappingChange, namesIdpKind } from "./idp-mapping-rule.js";

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
  /** Rows a retained audit entry shows a non-admin agent created or changed as a mapping. */
  nonAdmin: NonAdminIdpMapping[];
  /** Rows with no retained audit entry: who wrote them cannot be told. */
  unattributed: string[];
  /** The rows examined. */
  total: number;
}

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

/** Audit operations whose record image is the whole row. Others are merged onto the previous image. */
const FULL_IMAGE_OPERATIONS = new Set(["upsert", "insert", "put"]);

/** The record image an entry carries for `id`. */
function entryImage(entry: CredentialAuditEntry, id: string): Record<string, unknown> | null {
  const records = Array.isArray(entry.records) ? entry.records : [];
  const match = records.find((r: any) => r && typeof r === "object" && (r.id === undefined || r.id === id));
  return match && typeof match === "object" ? (match as Record<string, unknown>) : null;
}

/** Does a partial write with no known prior image set a mapping field? */
function partialTouchesMapping(image: Record<string, unknown>): boolean {
  if ("kind" in image && namesIdpKind(image.kind)) return true;
  if (IDP_MAPPING_IDENTITY_FIELDS.some((field) => field in image)) return true;
  return "status" in image && image.status !== IDP_SELF_SERVICE_STATUS;
}

/**
 * Did a retained audit entry by `agentUser` create `id` as a mapping or change
 * its mapping fields? Entries are replayed in timestamp order; an entry whose
 * prior state is not retained is judged on what it wrote.
 */
export function writtenByNonAdmin(id: string, entries: CredentialAuditEntry[], agentUser = NON_ADMIN_AGENT_HARPER_USER): boolean {
  const ordered = [...entries].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
  let image: Record<string, unknown> | null = null;
  let known = false; // whether `image` is the row's full state
  for (const entry of ordered) {
    const operation = String(entry.operation ?? "");
    if (operation === "delete") {
      image = null;
      known = true;
      continue;
    }
    const written = entryImage(entry, id);
    if (!written) continue;
    const full = FULL_IMAGE_OPERATIONS.has(operation);
    const next: Record<string, unknown> = full ? { ...written } : { ...(image ?? {}), ...written };
    if (entry.user_name === agentUser) {
      if (full || known) {
        if (isIdpMappingChange(known ? image : null, next)) return true;
      } else if (partialTouchesMapping(written)) {
        return true;
      }
    }
    image = next;
    known = known || full;
  }
  return false;
}

/**
 * The finding: every idp row a non-admin agent wrote as a mapping, and every
 * row whose writer cannot be told. PURE — it reports; nothing is rewritten.
 */
export function describeIdpMappingWriters(
  rows: IdpMappingRow[],
  auditById: Record<string, CredentialAuditEntry[]>,
  agentUser = NON_ADMIN_AGENT_HARPER_USER,
): IdpMappingWriterFinding {
  const nonAdmin: NonAdminIdpMapping[] = [];
  const unattributed: string[] = [];
  for (const row of rows) {
    const entries = auditById[row.id] ?? [];
    if (entries.length === 0) {
      unattributed.push(row.id);
      continue;
    }
    if (writtenByNonAdmin(row.id, entries, agentUser)) {
      nonAdmin.push({ id: row.id, principalId: String(row.principalId ?? ""), idpProvider: String(row.idpProvider ?? "") });
    }
  }
  nonAdmin.sort((a, b) => a.id.localeCompare(b.id));
  unattributed.sort();
  return { nonAdmin, unattributed, total: rows.length };
}

/** The finding's report lines: the warning (null when there is none), the remedy, and the unattributed note. */
export function idpMappingWriterLines(finding: IdpMappingWriterFinding): { warn: string | null; fix: string | null; info: string | null } {
  const warn = finding.nonAdmin.length === 0 ? null :
    `${finding.nonAdmin.length} IdP mapping row(s) written by a non-admin agent (from the audit log): ` +
    finding.nonAdmin.map((m) => `${m.id} (principal '${m.principalId}', provider '${m.idpProvider}')`).join(", ");
  const fix = finding.nonAdmin.length === 0 ? null :
    "review each with `flair principal links <principal>`; revoke one that should not resolve with " +
    "`flair principal unlink <principal> --idp-subject <subject> --idp-provider <provider>`. Doctor changed nothing.";
  const info = finding.unattributed.length === 0 ? null :
    `${finding.unattributed.length} IdP mapping row(s) have no retained audit entry (older than the audit log's ` +
    "retention, or copied by a cluster base copy), so who wrote them cannot be told; review them with " +
    "`flair principal links <principal>`. Writes made before the flair-agent user existed read as an administrator's.";
  return { warn, fix, info };
}
