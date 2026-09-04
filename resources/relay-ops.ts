/**
 * relay-ops.ts — Flair Relay S1 orchestration (send / inbox / consume / sweep /
 * dead-letter). Pure of Harper: every external dependency (the Message table,
 * the Agent table, org resolution) is INJECTED, so the full behavioural surface
 * is unit-testable with plain mocks and real ed25519 keys — no Harper instance,
 * and none of the bun-single-process superclass-capture hazard that mocking the
 * `harper` module invites. resources/Message.ts wires the real accessors in.
 *
 * All authorization decisions are made here against an already-resolved auth
 * verdict; the resource layer only resolves the verdict and forwards the call.
 */

import type { AgentAuthVerdict } from "./agent-auth.js";
import {
  capDecision,
  computeContentHash,
  isUnconsumed,
  LOCAL_ORG_SENTINEL,
  reconcileState,
  sweepDecision,
  verifyMessageSignature,
  type CapCounts,
  type MessageEnvelope,
  type MessageState,
} from "./relay-lib.js";

// ─── Injected dependencies ──────────────────────────────────────────────────

/** The subset of a Harper static table accessor relay-ops uses. */
export interface RelayTable {
  get(id: string): Promise<any> | any;
  put(row: any): Promise<any> | any;
  search(query?: any): AsyncIterable<any> | Iterable<any> | Promise<any[]>;
}

export interface RelayDeps {
  messages: RelayTable;
  agents: Pick<RelayTable, "get">;
  /** Server-side org resolution — the instance id, never the message body. */
  resolveOrg: () => Promise<string | null>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

// ─── HTTP responses (Response is a web global, not a Harper import) ──────────

const json = (status: number, obj: unknown): Response =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const UNAUTH = (): Response => json(401, { error: "authentication required" });
const FORBIDDEN = (error: string): Response => json(403, { error });
const NOT_FOUND = (): Response => json(404, { error: "not found" });
const BAD_REQUEST = (error: string): Response => json(400, { error });
/** A per-(from, threadId) sequence conflict — the seq is not strictly ahead of
 *  the thread's last message (Sherlock P1 seq monotonicity). */
const CONFLICT = (error: string): Response => json(409, { error, reason: "seq_conflict" });
/** Over-cap: a synchronous 4xx that names the reason — backpressure that fails loud. */
const INBOX_FULL = (scope: "recipient" | "sender"): Response =>
  json(429, { error: "inbox full", reason: "inbox_full", scope });

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Materialize a table.search() result (async iterable | iterable | promise) to
 * an array. `conditions` are passed to search() so a real Harper backend uses
 * the @indexed columns (`to`/`from`/`threadId`/`state` in schemas/message.graphql)
 * instead of a full-table scan — the Sherlock P0 fix: the cap-counter is the
 * DoS-preventer, so it must not itself be O(table). The in-code filters at each
 * call site remain the correctness guarantee (the unit-test table double ignores
 * the query and returns every row); the conditions are the production index hint.
 */
async function queryRows(
  table: RelayTable,
  conditions: ReadonlyArray<{ attribute: string; value: unknown }> = [],
): Promise<any[]> {
  const query =
    conditions.length > 0
      ? { operator: "and", conditions: conditions.map((c) => ({ attribute: c.attribute, comparator: "equals", value: c.value })) }
      : undefined;
  const res = table.search(query);
  const iter: any = res && typeof (res as any).then === "function" ? await res : res;
  const out: any[] = [];
  for await (const row of iter) out.push(row);
  return out;
}

// `from` is REQUIRED: it is inside the SIGNED body, so it must be present BEFORE
// signature verification and can never be server-mutated first (Sherlock P1 —
// a mutated `from` would be signed-without / verified-with). A non-admin agent's
// `from` is enforced-equal to its authenticated id (no overwrite), not defaulted.
const REQUIRED_SEND_FIELDS = ["id", "from", "to", "threadId", "kind", "body", "createdAt", "signature"] as const;

/** The stable "accepted" projection — identical whether or not `to` exists. */
function acceptedView(row: MessageEnvelope): MessageEnvelope {
  return {
    id: row.id,
    orgScope: row.orgScope,
    from: row.from,
    to: row.to,
    threadId: row.threadId,
    seq: row.seq,
    kind: row.kind,
    createdAt: row.createdAt,
    contentHash: row.contentHash,
    state: row.state,
    deliveredAt: row.deliveredAt,
  };
}

// ─── send ───────────────────────────────────────────────────────────────────

/**
 * post(msg). Verifies the sender signature, resolves orgScope server-side,
 * enforces the no-forge `from`, dedups retries, enforces the inbox cap + the
 * per-sender sub-cap, and delivers. Returns the accepted envelope — the SAME
 * shape regardless of whether `to` exists (no existence oracle): the only
 * principal ever looked up is the sender (needed for its public key), which is
 * the authenticated caller and therefore always present.
 */
export async function relaySend(
  deps: RelayDeps,
  auth: AgentAuthVerdict,
  content: MessageEnvelope,
): Promise<Response | MessageEnvelope> {
  if (auth.kind === "anonymous") return UNAUTH();

  for (const f of REQUIRED_SEND_FIELDS) {
    if (content[f] === undefined || content[f] === null || content[f] === "") {
      return BAD_REQUEST(`missing required field: ${f}`);
    }
  }
  if (typeof content.seq !== "number" || !Number.isInteger(content.seq) || content.seq < 0) {
    return BAD_REQUEST("seq must be a non-negative integer");
  }
  // Validate `deadline` as a parseable ISO-8601 timestamp at send time. Left
  // unvalidated, a garbage string yields NaN in sweepDecision, `NaN > now` is
  // false, and the row sweeps to failed/deadline IMMEDIATELY (Kern nit). Absent
  // is fine (no deadline); present-but-unparseable is a 400.
  if (content.deadline !== undefined && content.deadline !== null) {
    if (typeof content.deadline !== "string" || Number.isNaN(new Date(content.deadline).getTime())) {
      return BAD_REQUEST("deadline must be a valid ISO-8601 timestamp");
    }
  }

  // No-forge `from`: a non-admin agent can only send AS itself. `from` is a
  // REQUIRED, SIGNED field — we ENFORCE equality (never overwrite, which would
  // invalidate the signature) and NEVER mutate it before verification (a
  // server-set `from` would be signed-without / verified-with — Sherlock P1).
  if (auth.kind === "agent" && !auth.isAdmin && content.from !== auth.agentId) {
    return FORBIDDEN("forbidden: `from` must match the authenticated agent");
  }

  // orgScope is server-resolved from the auth/pairing context and NEVER trusted
  // from the body. It is inside the signed body, so the caller must have signed
  // the correct org; any other value is a forged/foreign scope and is rejected.
  const resolvedOrg = (await deps.resolveOrg()) ?? LOCAL_ORG_SENTINEL;
  if (content.orgScope !== resolvedOrg) {
    return FORBIDDEN("forbidden: orgScope is server-resolved, not settable from the body");
  }

  // Verify the sender's signature against the sender's pinned public key.
  // `from` is guaranteed present by REQUIRED_SEND_FIELDS above (String() only
  // narrows the optional type — it can never be undefined here).
  const sender = await Promise.resolve(deps.agents.get(String(content.from))).catch(() => null);
  if (!sender?.publicKey) return FORBIDDEN("forbidden: unknown sender principal");
  const verdict = verifyMessageSignature(content, String(sender.publicKey));
  if (!verdict.ok) return BAD_REQUEST(`signature: ${verdict.reason}`);

  // Store the server-recomputed canonical hash (verified equal above).
  content.contentHash = computeContentHash(content);

  // Retry-dedup: an identical resend — same primary id, or the same content
  // hash from this sender to this recipient — returns the already-accepted
  // envelope. No second row, and (critically) no second charge against the cap.
  const existingById = await Promise.resolve(deps.messages.get(String(content.id))).catch(() => null);
  if (existingById) return acceptedView(existingById);

  // The recipient's inbox — queried by the @indexed `to`, never the whole table
  // (Sherlock P0). Serves both dedup (same content from this sender) and the cap.
  const recipientRows = await queryRows(deps.messages, [{ attribute: "to", value: content.to }]);
  const dup = recipientRows.find(
    (r) => r.from === content.from && r.to === content.to && r.contentHash === content.contentHash,
  );
  if (dup) return acceptedView(dup);

  // Seq monotonicity per (from, threadId): a distinct new message must be
  // STRICTLY ahead of the thread's last seq (Sherlock P1). Checked AFTER dedup so
  // a legitimate retry (same content, caught above) is never rejected. Queried by
  // the @indexed `threadId`, then filtered to this sender in-code.
  const threadRows = await queryRows(deps.messages, [{ attribute: "threadId", value: content.threadId }]);
  let prevMaxSeq = -1;
  for (const r of threadRows) {
    if (r.from !== content.from || r.threadId !== content.threadId) continue;
    if (typeof r.seq === "number" && r.seq > prevMaxSeq) prevMaxSeq = r.seq;
  }
  if (content.seq <= prevMaxSeq) {
    return CONFLICT(`seq ${content.seq} is not ahead of the last seq (${prevMaxSeq}) for this (from, threadId)`);
  }

  // Inbox cap + per-sender sub-cap — AFTER dedup, so a retry is never rejected.
  const counts: CapCounts = { recipientUnconsumed: 0, senderUnconsumed: 0 };
  for (const r of recipientRows) {
    if (r.to !== content.to || !isUnconsumed(r.state as MessageState | undefined)) continue;
    counts.recipientUnconsumed++;
    if (r.from === content.from) counts.senderUnconsumed++;
  }
  const cap = capDecision(counts);
  if (!cap.ok) return INBOX_FULL(cap.scope);

  // Strip client-supplied lifecycle fields from the stored row: they are NOT
  // under the signature (SIGNED_BODY_FIELDS excludes them), so a caller could
  // pre-set `state`/`consumedAt`/`failureReason` and have them persist. `state`
  // and `deliveredAt` are overwritten below regardless; consumedAt/failureReason
  // are dropped here (Kern nit — hygiene, no injection today but no drift later).
  const { state: _s, consumedAt: _c, failureReason: _f, deliveredAt: _d, ...clean } = content;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const row: MessageEnvelope = {
    ...clean,
    kind: content.kind ?? "message",
    state: "delivered",
    deliveredAt: now,
  };
  await deps.messages.put(row);
  return acceptedView(row);
}

// ─── inbox ──────────────────────────────────────────────────────────────────

/**
 * inbox(to). Unconsumed messages addressed to a principal, sorted by `seq`
 * (per §12 P1-5 — createdAt collides at ms). A non-admin agent may only read
 * its OWN inbox; admin/internal may read any.
 */
export async function relayInbox(
  deps: RelayDeps,
  auth: AgentAuthVerdict,
  requestedTo?: string,
): Promise<Response | MessageEnvelope[]> {
  if (auth.kind === "anonymous") return UNAUTH();
  const to = resolveSelfScope(auth, requestedTo);
  if (to instanceof Response) return to;

  // Queried by the @indexed `to` — bounded by this inbox, not the table (Sherlock P0).
  const rows = await queryRows(deps.messages, [{ attribute: "to", value: to }]);
  return rows
    .filter((r) => r.to === to && isUnconsumed(r.state as MessageState | undefined))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

// ─── consume / ack ────────────────────────────────────────────────────────

/**
 * consume(id). Marks a message consumed. Only the RECIPIENT may consume its own
 * message; a missing id or another principal's message is an indistinguishable
 * 404 (no enumeration). `consumed` is absorbing — consuming an already-consumed
 * message is an idempotent no-op that returns the row, never a regression.
 */
export async function relayConsume(
  deps: RelayDeps,
  auth: AgentAuthVerdict,
  id: string,
): Promise<Response | MessageEnvelope> {
  if (auth.kind === "anonymous") return UNAUTH();
  if (!id) return BAD_REQUEST("missing message id");

  const row = await Promise.resolve(deps.messages.get(id)).catch(() => null);
  if (!row) return NOT_FOUND();

  const isRecipient = auth.kind === "agent" && !auth.isAdmin ? row.to === auth.agentId : true;
  if (!isRecipient) return NOT_FOUND();

  if (row.state === "consumed") return row; // absorbing — idempotent

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const updated = { ...row, state: reconcileState(row.state as MessageState, "consumed"), consumedAt: now };
  await deps.messages.put(updated);
  return updated;
}

// ─── dead-letter ────────────────────────────────────────────────────────────

/**
 * The visible dead-letter: `failed` messages queryable by the SENDER (from ===
 * caller), each carrying its failureReason. A non-admin sees only its own
 * failures; admin/internal may query any sender.
 */
export async function relayDeadLetters(
  deps: RelayDeps,
  auth: AgentAuthVerdict,
  requestedFrom?: string,
): Promise<Response | MessageEnvelope[]> {
  if (auth.kind === "anonymous") return UNAUTH();
  const from = resolveSelfScope(auth, requestedFrom);
  if (from instanceof Response) return from;

  // Queried by the @indexed `from` + `state` — the sender's failed rows only,
  // never a full-table scan (Sherlock P0).
  const rows = await queryRows(deps.messages, [
    { attribute: "from", value: from },
    { attribute: "state", value: "failed" },
  ]);
  return rows
    .filter((r) => r.from === from && r.state === "failed")
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

// ─── deadline sweep ─────────────────────────────────────────────────────────

/**
 * Deadline sweep. Unconsumed past-deadline messages transition to a VISIBLE
 * `failed`/`deadline` state (the inverse of OrgEvent's silent expiry). Consumed
 * rows are NEVER regressed (absorbing). Admin/internal only — it is a
 * maintenance operation over the whole table.
 */
export async function relaySweepDeadlines(
  deps: RelayDeps,
  auth: AgentAuthVerdict,
): Promise<Response | { failed: number }> {
  if (auth.kind === "anonymous") return UNAUTH();
  if (auth.kind === "agent" && !auth.isAdmin) {
    return FORBIDDEN("forbidden: deadline sweep is an administrative operation");
  }

  const now = (deps.now ?? (() => new Date()))();
  // Only UNCONSUMED rows can sweep to failed — query the two unconsumed states
  // by the @indexed `state` and union by id, instead of scanning the whole table
  // (Sherlock P0). The id-dedup also makes this correct if a backend (or the
  // test double) returns overlapping rows across the two state queries.
  const byId = new Map<string, any>();
  for (const st of ["submitted", "delivered"] as const) {
    for (const r of await queryRows(deps.messages, [{ attribute: "state", value: st }])) {
      if (r?.id != null) byId.set(String(r.id), r);
    }
  }
  const rows = [...byId.values()];
  let failed = 0;
  for (const row of rows) {
    const outcome = sweepDecision(row, now);
    if (!outcome.fail) continue;
    // reconcileState guards the absorbing rule a second time: even if `row`
    // were consumed, "failed" could never win — belt and suspenders.
    const next = reconcileState(row.state as MessageState, "failed");
    if (next !== "failed") continue;
    await deps.messages.put({ ...row, state: "failed", failureReason: outcome.failureReason });
    failed++;
  }
  return { failed };
}

// ─── shared scoping ─────────────────────────────────────────────────────────

/** A non-admin is pinned to its own id; admin/internal may target any id. */
function resolveSelfScope(auth: AgentAuthVerdict, requested?: string): string | Response {
  if (auth.kind === "agent" && !auth.isAdmin) {
    if (requested && requested !== auth.agentId) {
      return FORBIDDEN("forbidden: can only act on your own messages");
    }
    return auth.agentId;
  }
  // admin or internal
  if (!requested) return FORBIDDEN("forbidden: a target principal id is required");
  return requested;
}
