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
/** Over-cap: a synchronous 4xx that names the reason — backpressure that fails loud. */
const INBOX_FULL = (scope: "recipient" | "sender"): Response =>
  json(429, { error: "inbox full", reason: "inbox_full", scope });

// ─── Helpers ────────────────────────────────────────────────────────────────

async function listAll(table: RelayTable): Promise<any[]> {
  const res = table.search();
  const iter: any = res && typeof (res as any).then === "function" ? await res : res;
  const out: any[] = [];
  for await (const row of iter) out.push(row);
  return out;
}

const REQUIRED_SEND_FIELDS = ["id", "to", "threadId", "kind", "body", "createdAt", "signature"] as const;

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
  if (typeof content.seq !== "number" || !Number.isInteger(content.seq)) {
    return BAD_REQUEST("seq must be an integer");
  }

  // No-forge `from`: a non-admin agent can only send AS itself. We ENFORCE
  // equality rather than overwrite (OrgEvent overwrites a would-be-forged
  // authorId, but Message's `from` is inside the SIGNED body — overwriting it
  // would invalidate the signature; rejecting a mismatch keeps both true).
  if (auth.kind === "agent" && !auth.isAdmin) {
    if (content.from && content.from !== auth.agentId) {
      return FORBIDDEN("forbidden: `from` must match the authenticated agent");
    }
    content.from = auth.agentId;
  }
  if (!content.from) return BAD_REQUEST("missing required field: from");

  // orgScope is server-resolved from the auth/pairing context and NEVER trusted
  // from the body. It is inside the signed body, so the caller must have signed
  // the correct org; any other value is a forged/foreign scope and is rejected.
  const resolvedOrg = (await deps.resolveOrg()) ?? LOCAL_ORG_SENTINEL;
  if (content.orgScope !== resolvedOrg) {
    return FORBIDDEN("forbidden: orgScope is server-resolved, not settable from the body");
  }

  // Verify the sender's signature against the sender's pinned public key.
  const sender = await Promise.resolve(deps.agents.get(content.from)).catch(() => null);
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

  const rows = await listAll(deps.messages);
  const dup = rows.find(
    (r) => r.from === content.from && r.to === content.to && r.contentHash === content.contentHash,
  );
  if (dup) return acceptedView(dup);

  // Inbox cap + per-sender sub-cap — AFTER dedup, so a retry is never rejected.
  const counts: CapCounts = { recipientUnconsumed: 0, senderUnconsumed: 0 };
  for (const r of rows) {
    if (r.to !== content.to || !isUnconsumed(r.state as MessageState | undefined)) continue;
    counts.recipientUnconsumed++;
    if (r.from === content.from) counts.senderUnconsumed++;
  }
  const cap = capDecision(counts);
  if (!cap.ok) return INBOX_FULL(cap.scope);

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const row: MessageEnvelope = {
    ...content,
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

  const rows = await listAll(deps.messages);
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

  const rows = await listAll(deps.messages);
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
  const rows = await listAll(deps.messages);
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
