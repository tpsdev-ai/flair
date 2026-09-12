/**
 * One wake cycle: drain this agent's catchup, launch (or reuse) a Cursor
 * Cloud Agent for each directed dispatch, then ack the watermark.
 *
 * Ack happens AFTER handoff, and only through the last successful event.
 * A failed launch does not advance the cursor — the event stays queued
 * (at-least-once). Redelivery of an already-launched event hits Cursor
 * 409 and is treated as success, then acked — no second launch.
 */

import { wakeAgentId } from "./agent-id.js";
import type { CatchupPort } from "./catchup.js";
import type { CursorAgentClient, LaunchResult } from "./cursor-api.js";
import { classifyDispatch, type DirectedDispatch } from "./dispatch.js";

export interface WakeItem {
  eventId: string;
  kind: string;
  position: string | null;
  action: "launched" | "already" | "dry-run" | "skipped" | "blocked";
  cursorAgentId?: string;
  url?: string;
  reason?: string;
}

export interface WakeResult {
  drained: number;
  launched: number;
  reused: number;
  skipped: number;
  acked: string | null;
  blocked: string | null;
  items: WakeItem[];
}

export interface WakeDeps {
  agentId: string;
  catchup: CatchupPort;
  cursor: CursorAgentClient;
  /** When true, classify only — no Cursor create, no watermark ack. */
  dryRun?: boolean;
  pageLimit?: number;
}

function emptyResult(): WakeResult {
  return { drained: 0, launched: 0, reused: 0, skipped: 0, acked: null, blocked: null, items: [] };
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
