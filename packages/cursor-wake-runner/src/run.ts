/**
 * Drain the client's catchup feed and launch or reuse a Cursor agent for each
 * directed dispatch. The exported live cycle loads and validates an Ed25519 key
 * before reading the feed, then signs every FlairClient request with that cached
 * key. Cursor requests use Cursor API Basic authentication with CURSOR_API_KEY.
 * The catchup reader and receipt store use the same Flair client.
 *
 * Dry-run performs no Cursor create, receipt write or ack. Its catchup read may
 * create an AgentReadPosition. A launch outcome inconsistent with the mode throws
 * before recording that event or attempting its receipt; earlier events in a
 * live cycle may already have receipts.
 *
 * Skipped events are ackable. A handoff is ackable after a successful receipt
 * write, a verified existing receipt, or a classified non-retryable refusal.
 * Launch failure, receipt failure or mismatch stops processing that event; the
 * cycle may still ack earlier successful or skipped events. A 409 classified as
 * an agent-id conflict is treated as already handed off under the same ack rules.
 *
 * The exported entry builds production parts. Tests can supply catchup and Cursor
 * clients to the internal core, which the package entry does not export.
 */

import type { FlairClient } from "@tpsdev-ai/flair-client";
import { MissingSigningKeyError } from "@tpsdev-ai/flair-client";
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
  /** flair#1944 — the handoff's receipt outcome: "written" or "unchanged" (a VERIFIED existing receipt), "refused" (a non-retryable refusal; ackable without it), "failed" (transient or configuration; not acked), or "mismatched" (the id is held by a row not verified as this receipt; not acked). */
  receipt?: "written" | "unchanged" | "failed" | "refused" | "mismatched";
}

/** A non-retryable receipt refusal; the event is ackable without its receipt. */
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
  /** flair#1944 — receipts the runner treats as non-retryable refusals (status + error code, when present); each event is ackable without its receipt. */
  receiptRefused: WakeReceiptRefusal[];
  items: WakeItem[];
}

export interface WakeDeps {
  /** The runner's Flair client. The exported live cycle requires signing;
   *  feed and receipt operations use this client and its agentId. */
  client: FlairClient;
  /**
   * Cursor Cloud Agents launch config. The runner builds its Cursor client from
   * THIS and the mode, never from the Flair client: a LIVE cycle builds
   * `createCursorAgentClient(config)` from these fields; a dry-run cycle uses
   * `dryRunCursorClient` instead, which never CALLS Cursor (the cycle still reads
   * the agent's Flair feed).
   */
  cursor: CursorLaunchConfig;
  /** One line for a receipt that omits a value the server's grammar would refuse, and one for a classified non-retryable refusal. */
  log?: (line: string) => void;
  /** When true, no Cursor create, receipt write or ack; catchup may persist its position. */
  dryRun?: boolean;
  pageLimit?: number;
}

/**
 * The interchangeable parts a wake cycle drives. flair#1944 round 8: the seams a
 * TEST may substitute live HERE, on the internal `runWakeCycleCore`, never on the
 * exported `runWakeCycle` — which builds production parts only. A test feeds
 * canned events through a fake Flair client (whose `request` serves the catchup
 * feed) and drives a fake Cursor endpoint. The receipt store and the agent id are
 * NOT part of these parts: the core still builds the store from `deps.client`, so
 * the runner identity is `deps.client.agentId`.
 */
export interface WakeCycleParts {
  catchup: CatchupPort;
  cursor: CursorAgentClient;
}

/** flair#1944 round 7/8 — a construction fault: the parts a cycle was built with
 *  do not match its mode. Thrown, not swallowed into `blocked`: it is refused by
 *  name before that event is recorded or its receipt attempted. Earlier events
 *  in a live cycle may already have receipts. */
class CycleConstructionError extends Error {}

/** A `dry-run` launch outcome seen in a LIVE cycle (a dry-run client reached a
 *  live cycle). */
class DryRunInLiveCycleError extends CycleConstructionError {}

/** flair#1944 round 8 — a live outcome (`created`/`already`) seen in a DRY-RUN
 *  cycle: a write-capable Cursor client reached a cycle that must classify only.
 *  Refused, by name, BEFORE `recordLaunch`, so a dry-run cycle writes no receipt. */
class LiveOutcomeInDryRunError extends CycleConstructionError {}

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
 * Attempt the launch receipt for a handed-off dispatch.
 *
 * A row already present under the stable id is LEFT UNCHANGED only when it
 * VERIFIES as this runner's own receipt (isStoredReceipt — same author, same
 * deterministic content, same host-source identity). An `already` result
 * contributes no url to the receipt, and a verified stored receipt stands. A row that fails
 * that check is not verified as this receipt: it surfaces as `"mismatched"` and
 * the caller does NOT ack it. A write the runner treats as a non-retryable
 * refusal (permanentReceiptRefusal) surfaces as `"refused"` with its status and
 * error code; that event is ackable. Any other read or write failure surfaces
 * as `"failed"` (the event remains unacked and can be retried if another cycle runs).
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
    // A failed read leaves the event unacked; it can be retried if another cycle runs.
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

/** Load and validate the live cycle's Ed25519 key before any requests.
 *  Every subsequent FlairClient request uses the cached key, even if its file
 *  disappears after loading. A missing or unusable key is refused by name. */
export async function assertLiveCycleSigningKey(client: FlairClient): Promise<void> {
  try {
    await client.loadSigningKey();
  } catch (err) {
    const detail = err instanceof MissingSigningKeyError ? err.detail : err instanceof Error ? err.message : String(err);
    throw new Error(
      `cursor-wake: live receipts need the agent's signing key — for FLAIR_AGENT_ID=${client.agentId} ` +
        `the client could not load a usable Ed25519 key (${detail}); set FLAIR_KEY_PATH to the agent's .key file ` +
        "(admin Basic credentials are only for --dry-run)",
    );
  }
}

export async function runWakeCycle(deps: WakeDeps): Promise<WakeResult> {
  // Load the key and require signing for every FlairClient request before
  // building parts or reading the feed. Cursor uses its own API authentication.
  if (!deps.dryRun) await assertLiveCycleSigningKey(deps.client);
  // flair#1944 round 8 — PRODUCTION PARTS ONLY. The exported entry builds every
  // part from the inputs it is given and nothing else: the catchup reader from
  // the runner's own client, the receipt store from that same client (inside the
  // core), and the Cursor client from `dryRun` + the Cursor config. There is no
  // public override; a test drives the seams through
  // `runWakeCycleCore`, which `src/index.ts` does not export.
  const cursor = deps.dryRun ? dryRunCursorClient() : createCursorAgentClient(deps.cursor);
  return runWakeCycleCore(deps, { catchup: createCatchupPort(deps.client), cursor });
}

/**
 * TEST-ONLY entry point — NOT part of the package's public entry (`src/index.ts`
 * exports `runWakeCycle`, not this). It runs the cycle on the two parts handed to
 * it, so a test can drive a canned feed through a fake Flair client and a fake
 * Cursor endpoint without a network. It can NEVER supply a receipt store or an
 * agent id: the store is still `createMemoryReceiptStore(deps.client)` and the
 * runner identity is still `deps.client.agentId`.
 */
export async function runWakeCycleCore(deps: WakeDeps, parts: WakeCycleParts): Promise<WakeResult> {
  // The runner identity and receipt store come from deps.client.
  const client = deps.client;
  const agentId = client.agentId;
  const catchup = parts.catchup;
  const store = createMemoryReceiptStore(client);
  const cursor = parts.cursor;

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
        // client from `dryRun`, so a live cycle can only see `dry-run` through the
        // internal core's seam. Refuse it before recording this event or attempting
        // its receipt; earlier events in this cycle may already have receipts.
        if (!deps.dryRun && launch.outcome === "dry-run") {
          throw new DryRunInLiveCycleError(
            `runWakeCycle: the Cursor client reported a \`dry-run\` outcome for ${dispatch.id} in a live cycle; ` +
              "a live cycle must launch for real (the dry-run client is only for --dry-run)",
          );
        }
        // flair#1944 round 8 — defence in depth, the other direction. The runner
        // picks the Cursor client from `dryRun`, so a dry-run cycle can only see a
        // live outcome through the internal core's seam. Refuse it, by name, BEFORE
        // `recordLaunch`: a dry-run cycle classifies only, records no receipt and
        // acks nothing — so no receipt write can happen in dry-run.
        if (deps.dryRun && (launch.outcome === "created" || launch.outcome === "already")) {
          throw new LiveOutcomeInDryRunError(
            `runWakeCycle: the Cursor client reported a \`${launch.outcome}\` outcome for ${dispatch.id} in a dry-run cycle; ` +
              "a dry-run cycle classifies only, records no receipt and acks nothing",
          );
        }
        recordLaunch(result, dispatch, launch);

        // flair#1944: after a handoff (never on dry-run), ATTEMPT one launch
        // receipt BEFORE the ack — the receipt is "sourced" only when a pointer
        // was STORED (an id the server's grammar refuses stores none, so that
        // receipt is stored unsourced and gets no host-source citation), and a READ or WRITE
        // failure can prevent the receipt entirely. The ack follows a successful
        // write OR
        // an existing row VERIFIED as this runner's receipt. A transient or
        // configuration failure leaves the event unacked; it can be retried if
        // another cycle runs. A refusal the runner treats as non-retryable is reported and
        // the event is ackable without its receipt. A row
        // at the id that is NOT this runner's receipt does not ack either — it is
        // reported and left untouched.
        if (launch.outcome === "created" || launch.outcome === "already") {
          const receipt = await recordLaunchReceipt(agentId, store, dispatch, launch, deps.log);
          result.items[result.items.length - 1].receipt = receipt.status;
          if (receipt.status === "refused") {
            const { status, code } = receipt.refusal;
            result.receiptRefused.push({ eventId: dispatch.id, status, code });
            deps.log?.(
              `cursor-wake: receipt for ${dispatch.id} refused (HTTP ${status}${code ? ` ${code}` : ""}); the runner treats it as non-retryable and the event is ackable without it — the launch stands`,
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
        if (err instanceof CycleConstructionError) throw err;
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
