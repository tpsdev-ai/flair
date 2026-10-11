/**
 * One wake cycle: drain this agent's catchup, launch (or reuse) a Cursor
 * Cloud Agent for each directed dispatch, attempt a launch receipt, then ack
 * the watermark.
 *
 * ONE signed client, ONE runner identity (flair#1944 round 7). The cycle takes a
 * single Flair client and BUILDS the catchup feed reader and the receipt store
 * from that same client; the runner identity IS the client's signing identity.
 * There is no separate `agentId` label to trust and no caller-supplied store, so
 * a receipt can never be signed as a different agent than the feed it drains —
 * the "store labelled A writing as B" combination is unrepresentable rather than
 * guarded. The Cursor client is likewise chosen by the runner from `dryRun`
 * (live -> the real client built from the config; dry-run -> `dryRunCursorClient`),
 * and a `dry-run` outcome observed in a LIVE cycle is refused, by name, before
 * anything is acked (defence in depth against a dry-run client reaching a live
 * cycle).
 *
 * Ack happens AFTER handoff and AFTER a receipt — a successful write, or an
 * existing row VERIFIED as this runner's own receipt — and only through the last
 * successful event. ONE receipt outcome is acked WITHOUT one: a receipt the
 * runner treats as a non-retryable refusal (400/409/413/422), reported as
 * `receiptRefused` (the launch is real and the receipt is provenance, not
 * control). Otherwise nothing advances the cursor — a failed launch, a receipt
 * write that failed for a transient or configuration reason, or a row already at
 * the receipt id not verified as this receipt (a foreign author, a different
 * content, or a different host-source identity), reported as `receiptMismatched`
 * — the event stays queued (at-least-once). Redelivery of an already-launched
 * event hits Cursor 409 and is treated as success, then the receipt is retried;
 * a 409 redelivery is retried and acked when its receipt write succeeds, a
 * verified receipt exists, or the receipt is a classified non-retryable refusal
 * (which is acked without one) — no second launch.
 */

import type { FlairClient } from "@tpsdev-ai/flair-client";
import { wakeAgentId } from "./agent-id.js";
import { createCatchupPort, type CatchupPort } from "./catchup.js";
import { createCursorAgentClient, dryRunCursorClient, type CursorAgentClient, type CursorLaunchConfig, type LaunchResult } from "./cursor-api.js";
import { classifyDispatch, type DirectedDispatch } from "./dispatch.js";
import { createMemoryReceiptStore } from "./receipt-store.js";
import { buildLaunchReceipt, isStoredReceipt, permanentReceiptRefusal, type LaunchReceipt, type ReceiptRefusal, type ReceiptStore, type StoredReceipt } from "./receipt.js";

export interface WakeItem {
  eventId: string;
  kind: string;
  position: string | null;
  action: "launched" | "already" | "dry-run" | "skipped" | "blocked";
  cursorAgentId?: string;
  url?: string;
  reason?: string;
  /** flair#1944 — the launch receipt this handoff recorded: "written" or "unchanged" (a VERIFIED existing receipt), "refused" (a non-retryable refusal; acked without it), "failed" (transient or configuration; not acked), or "mismatched" (the id is held by a row not verified as this receipt; not acked). */
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
   * flair#1944 round 3 — set when a row already at the receipt id is NOT
   * verified as this receipt (a foreign author, a different content, or a
   * different host-source identity); the row is left untouched and the watermark
   * is not advanced past it.
   */
  receiptMismatched: string | null;
  /** flair#1944 — receipts the runner treats as non-retryable refusals (status + error code, when present); each event was acked without its receipt. */
  receiptRefused: WakeReceiptRefusal[];
  items: WakeItem[];
}

export interface WakeDeps {
  /**
   * The runner's OWN signed Flair client. Its signing identity IS the runner
   * identity: the catchup feed reader and the receipt store are BOTH built from
   * THIS client, so a receipt is always signed as exactly the agent whose feed
   * was drained. There is no separate `agentId` and no caller-supplied store to
   * disagree with it.
   */
  client: FlairClient;
  /**
   * Cursor Cloud Agents launch config. The runner builds its Cursor client from
   * this for a LIVE cycle; a dry-run cycle uses `dryRunCursorClient` instead and
   * never touches the network.
   */
  cursor: CursorLaunchConfig;
  /** One line for a receipt that omits a value the server's grammar would refuse, and one for a receipt the server refused. */
  log?: (line: string) => void;
  /** When true, classify only — no Cursor create, no receipt, no watermark ack. */
  dryRun?: boolean;
  pageLimit?: number;
  /**
   * TEST-ONLY seam — the shipped CLI never sets it. `runWakeCycle` builds the
   * feed reader, the receipt store and the Cursor client from `client`/`cursor`
   * alone; a test uses this to supply a canned catchup feed and/or a fake Cursor
   * client without a network. It can NEVER supply a receipt store or an agent
   * id: the runner identity and the signer are always the client's, so a
   * mismatched signer is unrepresentable here.
   */
  __test?: {
    catchup?: CatchupPort;
    cursor?: CursorAgentClient;
  };
}

/** flair#1944 round 7 — a `dry-run` launch outcome seen in a LIVE cycle. Thrown,
 *  not swallowed into `blocked`: it is a construction fault (a dry-run client
 *  reached a live cycle), refused by name before anything is recorded or acked. */
class DryRunInLiveCycleError extends Error {}

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

/** Name, for the mismatch failure, the COMPARISON that failed — why a stored row
 *  is not verified as this receipt. */
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
 * that check is not verified as this receipt: it surfaces as `"mismatched"` and
 * the caller does NOT ack it. A write the runner treats as a non-retryable
 * refusal (permanentReceiptRefusal) surfaces as `"refused"` with its status and
 * error code; the caller acks past it. Any other read or write failure surfaces
 * as `"failed"` (the caller keeps the watermark back and the next cycle
 * retries). Never a thrown crash.
 */
async function recordLaunchReceipt(
  agentId: string,
  store: ReceiptStore,
  dispatch: DirectedDispatch,
  launch: LaunchResult,
  log?: (line: string) => void,
): Promise<
  | { status: "written" | "unchanged" }
  | { status: "failed"; error: string }
  | { status: "refused"; refusal: ReceiptRefusal }
  | { status: "mismatched"; detail: string }
> {
  // flair#1944 round 6 — the url is written ONLY for a create. An `already`
  // (409) result can carry a url too, but the receipt's url belongs to the
  // ORIGINAL create; a serialized replay that reads the existing receipt must
  // not rewrite the stored one.
  const { receipt, omittedUrl, omittedSource } = buildLaunchReceipt(dispatch.id, {
    cursorAgentId: launch.cursorAgentId,
    ...(launch.outcome === "created" && launch.url !== undefined ? { url: launch.url } : {}),
  });
  if (omittedSource) {
    log?.(`cursor-wake: receipt for ${dispatch.id} omits its host source: the server's host-source grammar would refuse the Cursor agent id`);
  } else if (omittedUrl) {
    log?.(`cursor-wake: receipt for ${dispatch.id} omits the agent url: the server's host-source grammar would refuse it`);
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
    // source is not verified as this receipt — refuse WITHOUT overwriting it and
    // WITHOUT acking.
    if (isStoredReceipt(stored, agentId, receipt)) return { status: "unchanged" };
    return {
      status: "mismatched",
      detail: `receipt id ${receipt.id} is not verified as this receipt: ${mismatchReason(stored, agentId, receipt)}`,
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
  // flair#1944 round 7 — ONE client, ONE identity. The runner identity is the
  // client's signing identity; the catchup feed reader and the receipt store are
  // built from that same client, so a receipt can never be signed as a different
  // agent than the feed drained, and there is no store to supply.
  const client = deps.client;
  const agentId = client.agentId;
  const catchup = deps.__test?.catchup ?? createCatchupPort(client);
  const store = createMemoryReceiptStore(client);
  const cursor = deps.__test?.cursor ?? (deps.dryRun ? dryRunCursorClient() : createCursorAgentClient(deps.cursor));

  const result = emptyResult();
  let after: string | undefined;
  let lastAckable: string | null = null;

  for (;;) {
    const page = await catchup.drain(after, deps.pageLimit);
    const events = Array.isArray(page.events) ? page.events : [];
    result.drained += events.length;

    for (const event of events) {
      const position = typeof event.position === "string" ? event.position : null;
      const dispatch = classifyDispatch(event, agentId);

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
            if (!deps.dryRun && lastAckable) await catchup.ack(lastAckable);
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
        const launch = await cursor.create({
          cursorAgentId,
          dispatch,
          crewAgentId: agentId,
        });
        // flair#1944 round 7 — defence in depth: the runner picks the Cursor
        // client from `dryRun`, so a live cycle can only see `dry-run` through a
        // test seam. Refuse it, by name, BEFORE anything is recorded or acked —
        // a live handoff must be a real launch, not a dry-run classification.
        if (!deps.dryRun && launch.outcome === "dry-run") {
          throw new DryRunInLiveCycleError(
            `runWakeCycle: the Cursor client reported a \`dry-run\` outcome for ${dispatch.id} in a live cycle; ` +
              "a live cycle must launch for real (the dry-run client is only for --dry-run)",
          );
        }
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
          const receipt = await recordLaunchReceipt(agentId, store, dispatch, launch, deps.log);
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
            if (!deps.dryRun && lastAckable) await catchup.ack(lastAckable);
            result.acked = deps.dryRun ? null : lastAckable;
            return result;
          }
          if (receipt.status === "mismatched") {
            result.receiptMismatched = receipt.detail;
            if (!deps.dryRun && lastAckable) await catchup.ack(lastAckable);
            result.acked = deps.dryRun ? null : lastAckable;
            return result;
          }
        }
        if (dispatch.position) lastAckable = dispatch.position;
      } catch (err) {
        // A construction fault is not a launch failure: re-raise it untouched.
        if (err instanceof DryRunInLiveCycleError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        result.blocked = `launch failed for ${dispatch.id}: ${message}`;
        result.items.push({
          eventId: dispatch.id,
          kind: dispatch.kind,
          position: dispatch.position,
          action: "blocked",
          reason: result.blocked,
        });
        if (!deps.dryRun && lastAckable) await catchup.ack(lastAckable);
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

  if (!deps.dryRun && lastAckable) await catchup.ack(lastAckable);
  result.acked = deps.dryRun ? null : lastAckable;
  return result;
}
