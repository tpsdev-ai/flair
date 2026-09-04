/**
 * relay-lib.ts — Flair Relay S1 pure logic (no Harper imports).
 *
 * Extracted from the Message resource the same way federation-classify.ts is
 * extracted from Federation.ts: the load-bearing decisions (canonical signing
 * body, contentHash, inbox cap + per-sender sub-cap, and the absorbing
 * state machine) are pure functions that can be unit-tested without spinning
 * a Harper instance, and are the single source of truth shared by the
 * Message resource (send/inbox/consume/sweep) and the federation apply path.
 *
 * Design + review amendments: Flair Relay S1 (flair#1521) §4 (envelope +
 * delivery) and §12 (binding review amendments — P0-3 absorbing state, P0-4
 * contentHash, P0(S) per-sender sub-caps + server-resolved orgScope, P1-5 seq).
 */

import { createHash } from "node:crypto";
import { canonicalize, signBody, verifyBodySignature } from "./federation-crypto.js";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** Message lifecycle states (A2A-aligned subset; S1 uses these four). */
export type MessageState = "submitted" | "delivered" | "consumed" | "failed";

/** A `failed` row always carries one of these reasons — the visible dead-letter. */
export type FailureReason = "deadline" | "inbox_full";

/**
 * `consumed` is ABSORBING (§12 P0-3): once a message is consumed, no later
 * write — a deadline sweep, a redelivered original, a federation merge — may
 * regress it. The sender must never be told "failed" about a message the
 * recipient actually consumed. That inversion is the exact bug this design
 * exists to kill.
 */
export const ABSORBING_STATE: MessageState = "consumed";

// ─── Caps (§12 P0(S) — DoS lever) ───────────────────────────────────────────
//
// A global cap alone lets one hostile sender pin a recipient's whole inbox and
// lock everyone else out. The per-sender sub-cap bounds any single sender well
// below the global cap, so a flooding sender only ever fills its own slice.
// Env-overridable for operators; defaults are deliberately generous.

export const DEFAULT_INBOX_CAP = 1000;
export const DEFAULT_PER_SENDER_CAP = 100;

export function inboxCap(): number {
  return positiveIntEnv(process.env.FLAIR_RELAY_INBOX_CAP, DEFAULT_INBOX_CAP);
}
export function perSenderCap(): number {
  return positiveIntEnv(process.env.FLAIR_RELAY_PER_SENDER_CAP, DEFAULT_PER_SENDER_CAP);
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Server-resolved org sentinel for an instance that has never federated (no
 * Instance row). The org scope is always the instance itself (single-tenant:
 * "an org/instance is one shared knowledge base") — resolved server-side,
 * NEVER trusted from the message body. Callers pass `localInstanceId() ?? this`.
 */
export const LOCAL_ORG_SENTINEL = "local";

// ─── Canonical bodies ───────────────────────────────────────────────────────
//
// TWO field sets, both pure functions of the envelope so sender and server
// compute byte-identical inputs:
//
//   contentHash — a stable fingerprint of the message CONTENT. Excludes `id`
//   and `createdAt` (a retry may restamp either) so an identical resend
//   dedups; includes `seq` so distinct messages in a thread never collide.
//
//   signed body — everything the signature covers: the content PLUS `id`,
//   `createdAt` and `contentHash`. Excludes only the mutable server/lifecycle
//   fields (`state`, `deliveredAt`, `consumedAt`, `failureReason`) and the
//   `signature` itself.

// `inReplyTo`/`parentContentHash` are the reply-linkage of the envelope
// (design §4.2). They land in S1 (though "understood" reply semantics are S3)
// and are CONTENT — two messages that differ only in what they reply to are
// distinct, so they belong in the contentHash (dedup key) AND under the
// signature (SIGNED_BODY_FIELDS), never trusted unsigned.
export const CONTENT_HASH_FIELDS = [
  "from",
  "to",
  "threadId",
  "seq",
  "kind",
  "body",
  "orgScope",
  "deadline",
  "inReplyTo",
  "parentContentHash",
  "senderModel",
  "senderProvider",
  "senderRunId",
] as const;

export const SIGNED_BODY_FIELDS = [
  "id",
  "from",
  "to",
  "threadId",
  "seq",
  "kind",
  "body",
  "orgScope",
  "deadline",
  "inReplyTo",
  "parentContentHash",
  "createdAt",
  "contentHash",
  "senderModel",
  "senderProvider",
  "senderRunId",
] as const;

export interface MessageEnvelope {
  id?: string;
  orgScope?: string;
  from?: string;
  to?: string;
  threadId?: string;
  seq?: number;
  kind?: string;
  body?: string;
  createdAt?: string;
  deadline?: string;
  inReplyTo?: string;
  parentContentHash?: string;
  state?: MessageState;
  deliveredAt?: string;
  consumedAt?: string;
  failureReason?: string;
  contentHash?: string;
  senderModel?: string;
  senderProvider?: string;
  senderRunId?: string;
  signature?: string;
  [k: string]: unknown;
}

/**
 * Pick only the named keys whose value is neither undefined nor null. Dropping
 * null/undefined (rather than emitting them) keeps canonicalization stable
 * across "field absent" vs "field explicitly null" — both sign the same bytes.
 */
function pick(obj: MessageEnvelope, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = obj[f];
    if (v !== undefined && v !== null) out[f] = v;
  }
  return out;
}

/** sha256 (hex) over the canonical content — retry-dedup key + integrity check. */
export function computeContentHash(msg: MessageEnvelope): string {
  const canonical = canonicalize(pick(msg, CONTENT_HASH_FIELDS));
  return createHash("sha256").update(canonical).digest("hex");
}

/** The exact object the ed25519 signature is taken over (no `signature` key). */
export function signedBody(msg: MessageEnvelope): Record<string, unknown> {
  return pick(msg, SIGNED_BODY_FIELDS);
}

/**
 * Seal a message for sending: stamp contentHash over the content, then sign the
 * full signed body (which now includes that contentHash) with the sender's
 * ed25519 secret key. Sender-side + test helper — the server never signs.
 */
export function sealMessage(msg: MessageEnvelope, secretKey: Uint8Array): MessageEnvelope {
  const contentHash = computeContentHash(msg);
  const withHash = { ...msg, contentHash };
  const signature = signBody(signedBody(withHash), secretKey);
  return { ...withHash, signature };
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "content_hash_mismatch" | "invalid_signature" };

/**
 * Server-side envelope verification:
 *   1. signature present,
 *   2. the sender-supplied contentHash actually matches the content (a second
 *      integrity check under the signature — §12 P0-4),
 *   3. the ed25519 signature verifies over the signed body against the
 *      sender's pinned public key.
 * Any tampered signed field flips (3); a forged contentHash flips (2).
 */
export function verifyMessageSignature(msg: MessageEnvelope, publicKeyB64url: string): SignatureVerdict {
  if (!msg.signature) return { ok: false, reason: "missing_signature" };
  const expectedHash = computeContentHash(msg);
  if (msg.contentHash !== expectedHash) return { ok: false, reason: "content_hash_mismatch" };
  const body = { ...signedBody(msg), signature: msg.signature };
  if (!verifyBodySignature(body, publicKeyB64url)) return { ok: false, reason: "invalid_signature" };
  return { ok: true };
}

// ─── Inbox cap + per-sender sub-cap (§12 P0(S)) ─────────────────────────────

export interface CapCounts {
  /** Unconsumed (submitted|delivered) messages already in the recipient's inbox. */
  recipientUnconsumed: number;
  /** Unconsumed messages in that inbox FROM this specific sender. */
  senderUnconsumed: number;
}

export type CapDecision =
  | { ok: true }
  | { ok: false; reason: "inbox_full"; scope: "recipient" | "sender" };

/**
 * Backpressure that fails LOUD: the send is rejected synchronously when the
 * recipient inbox is at the global cap OR this sender is at its sub-cap. The
 * sub-cap is checked first so a hostile sender is told exactly why, and a
 * recipient at the global cap because of ONE sender never masks a well-behaved
 * sender that still has room (their sub-cap is independent).
 */
export function capDecision(counts: CapCounts, caps = { inbox: inboxCap(), perSender: perSenderCap() }): CapDecision {
  if (counts.senderUnconsumed >= caps.perSender) {
    return { ok: false, reason: "inbox_full", scope: "sender" };
  }
  if (counts.recipientUnconsumed >= caps.inbox) {
    return { ok: false, reason: "inbox_full", scope: "recipient" };
  }
  return { ok: true };
}

// ─── Absorbing state machine (§12 P0-3) ─────────────────────────────────────

/** A message is still in the inbox (redeliverable) until consumed or failed. */
export function isUnconsumed(state: MessageState | undefined): boolean {
  return state === "submitted" || state === "delivered";
}

/**
 * Reconcile a would-be new state against the local one under the absorbing
 * rule. `consumed` always wins (over anything, in either position); `failed`
 * yields only to `consumed`. This is the single guard both the deadline sweep
 * and the federation merge path consult, so the invariant cannot drift between
 * them.
 */
export function reconcileState(localState: MessageState | undefined, incomingState: MessageState): MessageState {
  if (localState === "consumed" || incomingState === "consumed") return "consumed";
  if (localState === "failed") return "failed";
  return incomingState;
}

export type SweepOutcome =
  | { fail: true; failureReason: "deadline" }
  | { fail: false };

/**
 * Deadline sweep decision for one row at time `now`. Fails an unconsumed row
 * whose deadline has passed; NEVER touches a consumed row (absorbing) and
 * never re-fails an already-failed one, and never fails a row with no deadline.
 */
export function sweepDecision(row: MessageEnvelope, now: Date): SweepOutcome {
  if (!isUnconsumed(row.state as MessageState | undefined)) return { fail: false };
  if (!row.deadline) return { fail: false };
  if (new Date(row.deadline).getTime() > now.getTime()) return { fail: false };
  return { fail: true, failureReason: "deadline" };
}
