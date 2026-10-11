/**
 * One wake cycle: drain this agent's catchup, launch (or reuse) a Cursor
 * Cloud Agent for each directed dispatch, attempt a launch receipt, then ack
 * the watermark.
 *
 * Ack happens AFTER handoff and AFTER a receipt — a successful write, or an
 * existing row VERIFIED as this runner's own receipt — and only through the last
 * successful event. ONE receipt outcome is acked WITHOUT one: a receipt the
 * runner treats as a non-retryable refusal (400/409/413/422), reported as
 * `receiptRefused` (the launch is real and the receipt is provenance, not
 * control). Otherwise nothing advances the cursor — a failed launch, a receipt
 * write that failed for a transient or configuration reason, or a row already at
 * the receipt id that is NOT this runner's receipt (a foreign author, content or
 * source identity), reported as `receiptMismatched` — the event stays queued
 * (at-least-once). Redelivery of an already-launched event hits Cursor 409 and is
 * treated as success, then the receipt is retried and the event acked — no
 * second launch. The receipt store is REQUIRED for a live cycle (flair#1944 round
 * 2): a handoff is never acked with no receipt attempt.
 */

import { wakeAgentId } from "./agent-id.js";
import type { CatchupPort } from "./catchup.js";
import type { CursorAgentClient, LaunchResult } from "./cursor-api.js";
import { classifyDispatch, type DirectedDispatch } from "./dispatch.js";
import { buildLaunchReceipt, isStoredReceipt, permanentReceiptRefusal, type LaunchReceipt, type ReceiptRefusal, type ReceiptStore, type StoredReceipt } from "./receipt.js";

export interface WakeItem {
  eventId: string;
  kind: string;
  position: string | null;
  action: "launched" | "already" | "dry-run" | "skipped" | "blocked";
  cursorAgentId?: string;
  url?: string;
  reason?: string;
  /** flair#1944 — the launch receipt this handoff recorded: "written" or "unchanged" (a VERIFIED existing receipt), "refused" (a non-retryable refusal; acked without it), "failed" (transient or configuration; not acked), or "mismatched" (the id is held by a different record; not acked). */
  receipt?: "written" | "unchanged" | "failed" | "refused" | "mismatched";
}

/** flair#1944 — a launch receipt the runner treats as a non-retryable refusal; the event was acked without it. */
export interface WakeReceiptRefusal extends ReceiptRefusal {
  eventId: string;
}

export interface WakeResult {
  drained: number;
  launched: number;
  reused: number;
  skipped: number;
  acked: string | null;
  blocked: string | null;
  /** flair#1944 — set when a launch receipt could not be written for a transient or configuration reason; the watermark is not advanced past it. */
  receiptFailed: string | null;
  /**
   * flair#1944 round 3 — set when a row already at the receipt id is NOT this
   * runner's receipt (a foreign author, a different content, or a different host
   * source); the row is left untouched and the watermark is not advanced past it.
   */
  receiptMismatched: string | null;
  /** flair#1944 — receipts the runner treats as non-retryable refusals (status + error code, when present); each event was acked without its receipt. */
  receiptRefused: WakeReceiptRefusal[];
  items: WakeItem[];
}

export interface WakeDeps {
  agentId: string;
  catchup: CatchupPort;
  cursor: CursorAgentClient;
  /**
   * flair#1944 — where launch receipts are recorded. REQUIRED for a live
   * (non-dry-run) cycle: a handoff must never be acked with no receipt attempt.
   * A dry-run records nothing and never reads this, but must still supply one
   * for the type.
   */
  receipts: ReceiptStore;
  /** One line for a receipt that omits a value the server's grammar would refuse, and one for a receipt the server refused. */
  log?: (line: string) => void;
  /** When true, classify only — no Cursor create, no receipt, no watermark ack. */
  dryRun?: boolean;
  pageLimit?: number;
}

function emptyResult(): WakeResult {
  return {
    drained: 0,
    launched: 0,
    reused: 0,
    skipped: 0,
    acked: null,
    blocked: null,
    receiptFailed: null,
    receiptMismatched: null,
    receiptRefused: [],
    items: [],
  };
}

function recordLaunch(result: WakeResult, dispatch: DirectedDispatch, launch: LaunchResult): void {
  const action = launch.outcome === "created" ? "launched" : launch.outcome === "already" ? "already" : "dry-run";
  if (action === "launched") result.launched += 1;
  if (action === "already") result.reused += 1;
  result.items.push({
    eventId: dispatch.id,
    kind: dispatch.kind,
    position: dispatch.position,
    action,
    cursorAgentId: launch.cursorAgentId,
    url: launch.url,
  });
}

/** Name, for the mismatch failure, WHY a stored row is not this runner's receipt. */
function mismatchReason(stored: StoredReceipt, agentId: string, receipt: LaunchReceipt): string {
  if (stored.author !== agentId) return `another agent (${stored.author})`;
  if (stored.content !== receipt.content) return "different content";
  return "a different host source";
}

/**
 * Attempt the launch receipt for a handed-off dispatch, idempotently.
 *
 * A row already present under the stable id is LEFT UNCHANGED only when it
 * VERIFIES as this runner's own receipt (isStoredReceipt — same author, same
 * deterministic content, same host-source identity); a replay that reuses the
 * agent (409) carries no url, and the stored receipt stands. A row that fails
 * that check is a DIFFERENT record holding the id, surfaces as `"mismatched"` and
 * the caller does NOT ack it. A write the runner treats as a non-retryable
 * refusal (permanentReceiptRefusal) surfaces as `"refused"` with its status and
 * error code; the caller acks past it. Any other read or write failure surfaces
 * as `"failed"` (the caller keeps the watermark back and the next cycle
 * retries). Never a thrown crash.
 */
async function recordLaunchReceipt(
  deps: WakeDeps,
  dispatch: DirectedDispatch,
  launch: LaunchResult,
): Promise<
  | { status: "written" | "unchanged" }
  | { status: "failed"; error: string }
  | { status: "refused"; refusal: ReceiptRefusal }
  | { status: "mismatched"; detail: string }
> {
  const store = deps.receipts;
  const { receipt, omittedUrl, omittedSource } = buildLaunchReceipt(dispatch.id, launch);
  if (omittedSource) {
    deps.log?.(`cursor-wake: receipt for ${dispatch.id} omits its host source: the server's host-source grammar would refuse the Cursor agent id`);
  } else if (omittedUrl) {
    deps.log?.(`cursor-wake: receipt for ${dispatch.id} omits the agent url: the server's host-source grammar would refuse it`);
  }
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let stored: StoredReceipt | null;
  try {
    stored = await store.read(receipt.id);
  } catch (err) {
    // An unknown read never licenses a write, and is retried next cycle.
    return { status: "failed", error: message(err) };
  }
  if (stored !== null) {
    // A row IS there. Only a receipt that VERIFIES as this runner's own is
    // "unchanged"; a foreign author, a different content or a different host
    // source is a DIFFERENT record — refuse WITHOUT overwriting it and WITHOUT
    // acking.
    if (isStoredReceipt(stored, deps.agentId, receipt)) return { status: "unchanged" };
    return {
      status: "mismatched",
      detail: `receipt id ${receipt.id} is held by ${mismatchReason(stored, deps.agentId, receipt)}; it is not this runner's receipt`,
    };
  }
  try {
    await store.write(receipt);
    return { status: "written" };
  } catch (err) {
    const refusal = permanentReceiptRefusal(err);
    if (refusal) return { status: "refused", refusal };
    return { status: "failed", error: message(err) };
  }
}

export async function runWakeCycle(deps: WakeDeps): Promise<WakeResult> {
  if (!deps.dryRun && !deps.receipts) {
    // flair#1944 round 2: a live cycle must be able to record its receipt.
    // `receipts` is required by the type, but a JS caller could still omit it;
    // refuse rather than ack a handoff with no receipt attempt.
    throw new Error("runWakeCycle requires deps.receipts for a live cycle; pass dryRun to classify only");
  }
  const result = emptyResult();
  let after: string | undefined;
  let lastAckable: string | null = null;

  for (;;) {
    const page = await deps.catchup.drain(after, deps.pageLimit);
    const events = Array.isArray(page.events) ? page.events : [];
    result.drained += events.length;

    for (const event of events) {
      const position = typeof event.position === "string" ? event.position : null;
      const dispatch = classifyDispatch(event, deps.agentId);

      if (!dispatch) {
        const kind = typeof event.kind === "string" ? event.kind : "?";
        const eventId = typeof event.id === "string" ? event.id : "";
        if (kind === "coord.dispatch" || kind === "a2a.message") {
          if (typeof event.id !== "string" || event.id.length === 0) {
            result.blocked = "directed dispatch is missing an id — cannot derive an idempotent Cursor agentId";
            result.items.push({
              eventId,
              kind,
              position,
              action: "blocked",
              reason: result.blocked,
            });
            if (!deps.dryRun && lastAckable) await deps.catchup.ack(lastAckable);
            result.acked = deps.dryRun ? null : lastAckable;
            return result;
          }
        }
        result.skipped += 1;
        result.items.push({ eventId, kind, position, action: "skipped" });
        if (position) lastAckable = position;
        continue;
      }

      try {
        const cursorAgentId = wakeAgentId(dispatch.id);
        const launch = deps.dryRun
          ? { outcome: "dry-run" as const, cursorAgentId }
          : await deps.cursor.create({
              cursorAgentId,
              dispatch,
              crewAgentId: deps.agentId,
            });
        recordLaunch(result, dispatch, launch);

        // flair#1944: after a handoff (never on dry-run), ATTEMPT one sourced
        // launch receipt BEFORE the ack — the ack follows a successful write OR
        // an existing row VERIFIED as this runner's receipt. A transient or
        // configuration failure does not ack, so the next cycle retries the
        // receipt. A refusal the runner treats as non-retryable is reported and
        // the event acked: the launch is real, the receipt is provenance. A row
        // at the id that is NOT this runner's receipt does not ack either — it is
        // reported and left untouched. All are named outcomes, not a thrown
        // crash.
        if (launch.outcome === "created" || launch.outcome === "already") {
          const receipt = await recordLaunchReceipt(deps, dispatch, launch);
          result.items[result.items.length - 1].receipt = receipt.status;
          if (receipt.status === "refused") {
            const { status, code } = receipt.refusal;
            result.receiptRefused.push({ eventId: dispatch.id, status, code });
            deps.log?.(
              `cursor-wake: receipt for ${dispatch.id} refused (HTTP ${status}${code ? ` ${code}` : ""}); the runner treats it as non-retryable and acks the event without it — the launch stands`,
            );
          }
          if (receipt.status === "failed") {
            result.receiptFailed = `receipt not recorded for ${dispatch.id}: ${receipt.error}`;
            if (!deps.dryRun && lastAckable) await deps.catchup.ack(lastAckable);
            result.acked = deps.dryRun ? null : lastAckable;
            return result;
          }
          if (receipt.status === "mismatched") {
            result.receiptMismatched = receipt.detail;
            if (!deps.dryRun && lastAckable) await deps.catchup.ack(lastAckable);
            result.acked = deps.dryRun ? null : lastAckable;
            return result;
          }
        }
        if (dispatch.position) lastAckable = dispatch.position;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.blocked = `launch failed for ${dispatch.id}: ${message}`;
        result.items.push({
          eventId: dispatch.id,
          kind: dispatch.kind,
          position: dispatch.position,
          action: "blocked",
          reason: result.blocked,
        });
        if (!deps.dryRun && lastAckable) await deps.catchup.ack(lastAckable);
        result.acked = deps.dryRun ? null : lastAckable;
        return result;
      }
    }

    if (page.hasMore === true && page.nextAfter && events.length > 0) {
      after = page.nextAfter;
      continue;
    }
    break;
  }

  if (!deps.dryRun && lastAckable) await deps.catchup.ack(lastAckable);
  result.acked = deps.dryRun ? null : lastAckable;
  return result;
}
