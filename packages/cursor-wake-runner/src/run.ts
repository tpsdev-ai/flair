/**
 * One wake cycle: drain this agent's catchup, launch (or reuse) a Cursor
 * Cloud Agent for each directed dispatch, record a launch receipt, then ack
 * the watermark.
 *
 * Ack happens AFTER handoff and AFTER the receipt, and only through the last
 * successful event. A failed launch or a failed receipt write does not advance
 * the cursor — the event stays queued (at-least-once). Redelivery of an
 * already-launched event hits Cursor 409 and is treated as success, then the
 * receipt is retried and the event acked — no second launch.
 */

import { wakeAgentId } from "./agent-id.js";
import type { CatchupPort } from "./catchup.js";
import type { CursorAgentClient, LaunchResult } from "./cursor-api.js";
import { classifyDispatch, type DirectedDispatch } from "./dispatch.js";
import { buildLaunchReceipt, type ReceiptStore } from "./receipt.js";

export interface WakeItem {
  eventId: string;
  kind: string;
  position: string | null;
  action: "launched" | "already" | "dry-run" | "skipped" | "blocked";
  cursorAgentId?: string;
  url?: string;
  reason?: string;
  /** flair#1944 — the launch receipt this handoff recorded. */
  receipt?: "written" | "unchanged" | "failed";
}

export interface WakeResult {
  drained: number;
  launched: number;
  reused: number;
  skipped: number;
  acked: string | null;
  blocked: string | null;
  /** flair#1944 — set when a launch receipt could not be written; the watermark is not advanced past it. */
  receiptFailed: string | null;
  items: WakeItem[];
}

export interface WakeDeps {
  agentId: string;
  catchup: CatchupPort;
  cursor: CursorAgentClient;
  /** flair#1944 — where launch receipts are recorded. Omitted: no receipt is written. */
  receipts?: ReceiptStore;
  /** One line for a receipt that omits a value the server's grammar would refuse. */
  log?: (line: string) => void;
  /** When true, classify only — no Cursor create, no receipt, no watermark ack. */
  dryRun?: boolean;
  pageLimit?: number;
}

function emptyResult(): WakeResult {
  return { drained: 0, launched: 0, reused: 0, skipped: 0, acked: null, blocked: null, receiptFailed: null, items: [] };
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

/**
 * Record the launch receipt for a handed-off dispatch, idempotently.
 *
 * A receipt already present under the stable id is LEFT UNCHANGED: a replay
 * that reuses the agent (409) carries no url, and must never overwrite the
 * url-bearing receipt the first launch wrote. A read or write failure surfaces
 * as `"failed"` (the caller keeps the watermark back), never a thrown crash.
 */
async function recordLaunchReceipt(
  deps: WakeDeps,
  dispatch: DirectedDispatch,
  launch: LaunchResult,
): Promise<{ status: "written" | "unchanged" | "failed" | "none"; error?: string }> {
  const store = deps.receipts;
  if (!store) return { status: "none" };
  const { receipt, omittedUrl, omittedSource } = buildLaunchReceipt(dispatch.id, launch);
  if (omittedSource) {
    deps.log?.(`cursor-wake: receipt for ${dispatch.id} omits its host source: the Cursor agent id is not valid under the host-source id grammar`);
  } else if (omittedUrl) {
    deps.log?.(`cursor-wake: receipt for ${dispatch.id} omits the agent url: it is not an https url the host-source grammar accepts`);
  }
  try {
    if (await store.has(receipt.id)) return { status: "unchanged" };
    await store.write(receipt);
    return { status: "written" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runWakeCycle(deps: WakeDeps): Promise<WakeResult> {
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

        // flair#1944: after a handoff (never on dry-run), record ONE sourced
        // launch receipt BEFORE the ack. If the receipt write fails the event
        // is not acked, so the next cycle replays (Cursor 409 -> "already") and
        // retries the receipt. This is a named outcome, not a thrown crash.
        if (launch.outcome === "created" || launch.outcome === "already") {
          const receipt = await recordLaunchReceipt(deps, dispatch, launch);
          if (receipt.status !== "none") result.items[result.items.length - 1].receipt = receipt.status;
          if (receipt.status === "failed") {
            result.receiptFailed = `receipt not recorded for ${dispatch.id}: ${receipt.error ?? "unknown error"}`;
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
