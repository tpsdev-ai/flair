import { databases } from "harper";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { makeByIdReadGate, makeReadScope, makeScopedSearch } from "./record-type-kit.js";
import { resolveStoredRow } from "./originator-instance.js";
import { soulWriteSource } from "./soul-write-policy.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
import {
  TEAM_DIRECTORY_MAX_STRING_BYTES,
  TEAM_DIRECTORY_PLATFORM,
  isActiveAgentPrincipal,
  isValidPublicationStamp,
  utf8Bytes,
} from "./team-directory.js";

// Owner-only read scope, applied through the shared by-id gate and scoped search
// (resources/record-type-kit.ts).
const integrationReadScope = makeReadScope("owner-only", "agentId");
const integrationByIdReadGate = makeByIdReadGate(integrationReadScope);
const integrationScopedSearch = makeScopedSearch(integrationReadScope);

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
const BAD_REQUEST = (error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), { status: 400, headers: { "Content-Type": "application/json" } });
const CONFLICT = (error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), { status: 409, headers: { "Content-Type": "application/json" } });
const UNAVAILABLE = (error: string) =>
  new Response(JSON.stringify({ error }), { status: 503, headers: { "Content-Type": "application/json" } });
const OWNER_CHANGED = () =>
  new Response(JSON.stringify({
    error: "integration_owner_changed",
    message: "the record is owned by a different agent than the caller; the write was refused",
  }), { status: 403, headers: { "Content-Type": "application/json" } });

/** The field whose value is the team-directory publication stamp. */
const DIRECTORY_STAMP_FIELD = "directoryPublishedAt";

function hasField(content: any, field: string): boolean {
  return content != null && typeof content === "object" && Object.hasOwn(content, field);
}

/**
 * The operator source, or a refusal. Publication and withdrawal of a
 * team-directory contact are operator-only: `soulWriteSource` admits a verified
 * Basic administrator or the deliberate internal marker, and refuses runtime
 * credentials (agent keys, admin-agent keys, delegated OAuth identities).
 */
async function requireOperator(self: any, why: string): Promise<Response | null> {
  const context = (self as any).getContext?.();
  const auth = await resolveAgentAuth(context);
  if (auth.kind === "anonymous") return UNAUTH();
  if (!soulWriteSource(context, auth)) return FORBIDDEN(`integration_directory_requires_operator: ${why}`);
  return null;
}

/**
 * Validate a publication body against the exact approved binding
 * (`agentId`/`platform`/`email`). A read failure of the Agent table is a
 * refusal, never "the agent does not exist".
 */
async function validatePublication(content: any): Promise<Response | null> {
  if (typeof content?.agentId !== "string" || content.agentId === "") {
    return BAD_REQUEST("directory_publication_agent_required", "agentId must name the agent being published");
  }
  if (content.platform !== TEAM_DIRECTORY_PLATFORM) {
    return BAD_REQUEST("directory_publication_platform_unsupported", `only "${TEAM_DIRECTORY_PLATFORM}" contacts are published`);
  }
  if (typeof content.email !== "string" || content.email === "") {
    return BAD_REQUEST("directory_publication_email_required", "email must be a non-empty string");
  }
  if (utf8Bytes(content.email) > TEAM_DIRECTORY_MAX_STRING_BYTES) {
    return BAD_REQUEST("directory_publication_email_too_long", `email must be at most ${TEAM_DIRECTORY_MAX_STRING_BYTES} UTF-8 bytes`);
  }
  let agent: any;
  try {
    agent = await (databases as any).flair.Agent.get(content.agentId);
  } catch {
    return UNAVAILABLE("directory_publication_agent_store_unavailable");
  }
  if (!isActiveAgentPrincipal(agent) || agent.id !== content.agentId) {
    return FORBIDDEN("directory_publication_agent_not_active");
  }
  return null;
}

/** True when a delete target is one row id: a string or number, or a non-collection request target carrying one. */
function namesOneRow(target: any): boolean {
  if (typeof target === "string" || typeof target === "number") return true;
  if (target == null || typeof target !== "object" || target.isCollection === true) return false;
  return typeof target.id === "string" || typeof target.id === "number";
}

const BINDING_FROZEN = () =>
  CONFLICT(
    "integration_directory_withdraw_before_binding_change",
    "withdraw the published contact (set directoryPublishedAt to null) before changing its agentId, platform or email",
  );

/**
 * True when `stored` is published and this write would change its effective
 * agentId, platform or email. `replaces` is true for a full-row `put`, where an
 * omitted field is removed; otherwise an omitted field keeps its stored value.
 */
function changesPublishedBinding(content: any, stored: any, replaces: boolean): boolean {
  if (!stored || !isValidPublicationStamp(stored[DIRECTORY_STAMP_FIELD])) return false;
  return ["agentId", "platform", "email"].some((field) => {
    const next = hasField(content, field) ? content[field] : replaces ? undefined : stored[field];
    return next !== stored[field];
  });
}

/**
 * Decide the publication stamp this write should carry:
 *   - a server-stamped ISO time for a publication,
 *   - `null` for a withdrawal,
 *   - `undefined` when the write does not touch publication.
 */
async function resolvePublicationStamp(
  self: any,
  content: any,
  stored: any,
  replaces: boolean,
): Promise<{ denial?: Response; stamp?: string | null }> {
  if (hasField(content, DIRECTORY_STAMP_FIELD)) {
    const denial = await requireOperator(self, "publication and withdrawal are operator-only");
    if (denial) return { denial };
    if (content[DIRECTORY_STAMP_FIELD] === null) return { stamp: null };
    if (changesPublishedBinding(content, stored, replaces)) return { denial: BINDING_FROZEN() };
    const invalid = await validatePublication(content);
    if (invalid) return { denial: invalid };
    return { stamp: new Date().toISOString() };
  }

  if (changesPublishedBinding(content, stored, replaces)) return { denial: BINDING_FROZEN() };
  return {};
}

/** Aborts an Integration write's owned transaction: the committed row changed after the decision read. */
class IntegrationRowChangedDuringWrite extends Error {}

/** Attempts of a per-row Integration write before it gives up on a row that keeps changing. */
const INTEGRATION_WRITE_ATTEMPTS = 3;

/** The row this write lands on: the URL-bound target, else an explicit body id. */
function writeRowId(self: any, content: any): string | number | null {
  let bound: unknown;
  try {
    bound = (self as any).getId?.();
  } catch {
    bound = undefined;
  }
  if (typeof bound === "string" || typeof bound === "number") return bound;
  if (content != null && typeof content === "object") {
    const id = content.id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

type IntegrationWriteOutcome<T> =
  | { kind: "denial"; denial: Response }
  | { kind: "write"; id: string | number | null; expected: Record<string, any> | null; commit: (owned: any) => Promise<T> };

/**
 * Each attempt makes a per-row decision for an Integration write (flair#2340). The write's
 * decisions and the write run inside ONE owned transaction. When the write
 * names a stored row, the committed row is re-read OUTSIDE the transaction
 * (Harper's latest committed state) before the write is staged; when it is no
 * longer the row this attempt read, the transaction is aborted (nothing is
 * staged) and the attempt is retried from the committed row, up to
 * INTEGRATION_WRITE_ATTEMPTS times. If every attempt detects another change,
 * the request returns integration_row_changed.
 * POST reads no stored row; a generated-id POST names no row to re-read. A
 * denial stages no write and is returned unchanged. Mirrors the
 * re-read-then-abort pattern of flair#2307 (resources/Memory.ts).
 */
async function runIntegrationWrite<T>(
  ctx: any,
  attemptFn: (owned: any) => Promise<IntegrationWriteOutcome<T>>,
): Promise<T | Response> {
  const auth = await resolveAgentAuth(ctx);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withOwnedTransaction(ctx, async (owned) => {
        const outcome = await attemptFn(owned);
        if (outcome.kind === "denial") return outcome.denial;
        // Authorize non-admin agents against this attempt's stored row.
        // By-id middleware checks ownership before this read.
        // `expected` is null when the write lands on no stored row (a create).
        if (outcome.expected && auth.kind === "agent" && !auth.isAdmin && outcome.expected.agentId !== auth.agentId) {
          return OWNER_CHANGED();
        }
        // Test-only: inert unless the fault-injection env opt-in is set and armed.
        const pause = txnPausePoint("integration-row-write");
        if (pause) await pause;
        if (outcome.id != null) {
          const committed = await (databases as any).flair.Integration.get(outcome.id, {});
          if (!isDeepStrictEqual(committed ?? null, outcome.expected ?? null)) {
            throw new IntegrationRowChangedDuringWrite();
          }
        }
        return await outcome.commit(owned);
      });
    } catch (err) {
      if (!(err instanceof IntegrationRowChangedDuringWrite)) throw err;
      if (attempt >= INTEGRATION_WRITE_ATTEMPTS) {
        return CONFLICT(
          "integration_row_changed",
          "the record changed while this write was in progress; retry the write",
        );
      }
    }
  }
}

/**
 * Integration records are agent-owned. Auth: the non-rejecting gate annotates the
 * request; this resource self-enforces (resolveAgentAuth → internal/agent/anonymous).
 * Anonymous HTTP is denied on every path; non-admin agents are scoped to their own
 * agentId. Mirrors the WorkspaceState pattern.
 *
 * Integration resource publication writes require an operator source and stamp
 * the time. Resource writes freeze a published binding until withdrawal.
 */
export class Integration extends (databases as any).flair.Integration {
  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  /**
   * Self-authorize now that the global gate is non-rejecting (memory-soul-
   * read-gate family fix — same pattern as Memory.ts/Soul.ts/
   * WorkspaceState.ts/Relationship.ts). Closes the same P0 leak: Harper
   * routes `GET /Integration/<id>` to get() and the collection describe
   * (`GET /Integration`) outside search(), so neither was gated before this
   * fix — an anonymous caller got a 200 with full record content. Per-record
   * ownership scoping happens in get() below; the collection scope is still
   * in search().
   */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  /**
   * Override get() to scope by-id reads the same way search() scopes
   * collection reads (memory-soul-read-gate family fix). Never distinguishes
   * "doesn't exist" from "exists but not yours" — both return 404, never
   * 403, so a denied caller can't use get() to enumerate other agents'
   * integration ids.
   */
  async get(target?: any) {
    return integrationByIdReadGate.call(this, target, (t: any) => super.get(t));
  }

  async search(query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }
    return integrationScopedSearch(auth.agentId, query, (q: any) => super.search(q));
  }

  async post(content: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write integration for another agent");
    }
    // S31-A: API never accepts plaintext credentials.
    if (typeof content?.credential === "string" || typeof content?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return runIntegrationWrite((this as any).getContext?.(), async () => {
      const pub = await resolvePublicationStamp(this, content, null, true);
      if (pub.denial) return { kind: "denial" as const, denial: pub.denial };
      const now = new Date().toISOString();
      const record: any = { ...content, createdAt: now, updatedAt: now };
      if (pub.stamp !== undefined) record[DIRECTORY_STAMP_FIELD] = pub.stamp;
      return { kind: "write" as const, id: writeRowId(this, content), expected: null, commit: () => super.post(record, context) };
    });
  }

  // PATCH routes past put(), so agentId immutability is enforced on both verbs
  // via the one shared delegate.
  async patch(content: any, query?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write integration for another agent");
    }
    return runIntegrationWrite((this as any).getContext?.(), async (owned) => {
      const ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
      if (ownerDenial) return { kind: "denial" as const, denial: ownerDenial };
      const stored = await resolveStoredRow(this, "Integration", content, () => super.get(), owned);
      if (stored.denial) return { kind: "denial" as const, denial: stored.denial };
      // An absent addressed row answers NOT_FOUND instead of reaching
      // the write (flair#2322): deliberate and fail-closed for the
      // directory publication read, and a narrowing beyond that surface.
      if (!stored.row) return { kind: "denial" as const, denial: NOT_FOUND() };
      const pub = await resolvePublicationStamp(this, content, stored.row, false);
      if (pub.denial) return { kind: "denial" as const, denial: pub.denial };
      const changes: any = { ...content, createdAt: stored.row.createdAt, updatedAt: new Date().toISOString() };
      if (pub.stamp !== undefined) changes[DIRECTORY_STAMP_FIELD] = pub.stamp;
      // A patch merges into the row read in THIS attempt; the write is that row
      // plus the changes, written through the static table with the attempt's
      // owned context — not super.patch() on the request instance, whose cached
      // request-time entry drops a field another write committed (flair#2340).
      const merged: any = { ...stored.row, ...changes };
      return { kind: "write" as const, id: writeRowId(this, content), expected: stored.row, commit: (owned) => (databases as any).flair.Integration.put(merged, owned) };
    });
  }

  async put(content: any, context?: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return FORBIDDEN("forbidden: cannot write integration for another agent");
    }
    if (typeof content?.credential === "string" || typeof content?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return runIntegrationWrite((this as any).getContext?.(), async (owned) => {
      const ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
      if (ownerDenial) return { kind: "denial" as const, denial: ownerDenial };
      const stored = await resolveStoredRow(this, "Integration", content, () => super.get(), owned);
      if (stored.denial) return { kind: "denial" as const, denial: stored.denial };
      const pub = await resolvePublicationStamp(this, content, stored.row, true);
      if (pub.denial) return { kind: "denial" as const, denial: pub.denial };
      const now = new Date().toISOString();
      const record: any = {
        ...content,
        createdAt: stored.row ? stored.row.createdAt : now,
        updatedAt: now,
      };
      if (pub.stamp !== undefined) record[DIRECTORY_STAMP_FIELD] = pub.stamp;
      else if (stored.row) record[DIRECTORY_STAMP_FIELD] = stored.row[DIRECTORY_STAMP_FIELD] ?? null;
      const targetId = writeRowId(this, content);
      if (targetId != null) record.id = targetId;
      // A put REPLACES the row: full-replacement semantics, against the
      // attempt's owned context (the static table write), not the request
      // instance.
      return { kind: "write" as const, id: targetId, expected: stored.row, commit: (owned) => (databases as any).flair.Integration.put(record, owned) };
    });
  }

  async delete(id: any) {
    // A collection or query target can match many rows: require the operator
    // before any row is read.
    if (!namesOneRow(id)) {
      const denial = await requireOperator(this, "deleting by a collection or query target is operator-only");
      if (denial) return denial;
      if (id && typeof id === "object" && id.isCollection) {
        const scanTarget = Object.assign(
          new URLSearchParams(id instanceof URLSearchParams ? id : undefined),
          { sort: null },
          id,
          { select: ["$id"] },
        );
        for await (const row of await this.search(scanTarget)) {
          await super.delete((row as any).$id);
        }
        return true;
      }
      return super.delete(id);
    }

    // Authorize from the full stored row, read by id from the table, as one
    // per-row decision (flair#2340).
    const targetId = typeof id === "object" ? id.id : id;
    return runIntegrationWrite((this as any).getContext?.(), async (owned) => {
      const record = await (databases as any).flair.Integration.get(targetId, owned);

      // Removing a published directory entry is operator-only — a withdrawal
      // (directoryPublishedAt: null) is the routine way to hide it.
      if (record && isValidPublicationStamp(record[DIRECTORY_STAMP_FIELD])) {
        const denial = await requireOperator(this, "removing a published directory entry is operator-only; withdraw it instead");
        if (denial) return { kind: "denial" as const, denial };
        return { kind: "write" as const, id: targetId, expected: record, commit: (owned) => (databases as any).flair.Integration.delete(targetId, owned) };
      }

      const auth = await this._auth();
      if (auth.kind === "anonymous") return { kind: "denial" as const, denial: UNAUTH() };
      if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
        return { kind: "write" as const, id: targetId, expected: record, commit: (owned) => (databases as any).flair.Integration.delete(targetId, owned) };
      }
      if (!record) return { kind: "write" as const, id: targetId, expected: null, commit: (owned) => (databases as any).flair.Integration.delete(targetId, owned) };
      if (record.agentId !== auth.agentId) {
        return { kind: "denial" as const, denial: FORBIDDEN("forbidden: cannot delete integration for another agent") };
      }
      return { kind: "write" as const, id: targetId, expected: record, commit: (owned) => (databases as any).flair.Integration.delete(targetId, owned) };
    });
  }
}
