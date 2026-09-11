/**
 * OrgEventCatchup.ts — Paginated catch-up against a per-agent watermark.
 *
 * GET  /OrgEventCatchup/{participantId}?after=<position>&since=<ISO>&limit=50
 * POST /OrgEventCatchup/{participantId}  { position }
 *
 * Returns events where:
 *   - targetIds includes participantId OR targetIds is empty/null
 *   - position > after (after defaults to the durable per-agent watermark)
 *   - optional `since` is an extra createdAt floor, never the primary cursor
 *
 * Ordered by position ascending. Page-sized, never silently truncated
 * (`hasMore` + `nextAfter` — the caller pages until drained). Watermark
 * advances on ack (POST), not on read — at-least-once; consumers must be
 * idempotent (flair#931).
 */

import { Resource, databases } from "harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";
import {
  initialPosition,
  ORG_EVENT_STREAM,
  parsePageSize,
  positionAfterTimestamp,
} from "./agent-read-position-lib.js";
import {
  advanceReadPosition,
  defaultReadPositionTable,
  ensureReadPosition,
  getReadPosition,
} from "./agent-read-position.js";
import {
  catchupSeekTimestamp,
  collectCatchupEvents,
  pageCatchupEvents,
} from "./org-event-catchup-lib.js";

function queryValue(pathInfo: any, name: string): string | null {
  if (typeof pathInfo !== "object" || pathInfo === null) return null;
  return pathInfo.conditions?.find((c: any) => c.attribute === name)?.value ?? null;
}

function pathParticipantId(pathInfo: any, resource: { getId?: () => string }): string | null {
  return (
    (typeof pathInfo === "object" && pathInfo !== null ? pathInfo.id : null) ??
    (typeof pathInfo === "string" ? pathInfo : null) ??
    resource.getId?.() ??
    null
  );
}

function ownerDenied(auth: { kind: string; isAdmin?: boolean; agentId?: string }, participantId: string): boolean {
  if (auth.kind === "anonymous") return true;
  if (auth.kind === "agent" && !auth.isAdmin && auth.agentId !== participantId) return true;
  return false;
}

function forbidden(): Response {
  return new Response(
    JSON.stringify({ error: "forbidden: can only fetch events for yourself" }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

async function resolveAfter(
  participantId: string,
  pathInfo: any,
  ctx: unknown,
): Promise<{ after: string; watermark: string | null; since: string | null }> {
  const afterParam = queryValue(pathInfo, "after");
  const since = queryValue(pathInfo, "since");
  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      throw new Response(
        JSON.stringify({ error: "invalid since timestamp" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  const table = defaultReadPositionTable();
  const watermark = await getReadPosition(table, participantId, ORG_EVENT_STREAM, ctx);

  if (afterParam != null && afterParam !== "") {
    return { after: afterParam, watermark, since };
  }
  if (watermark) {
    return { after: watermark, watermark, since };
  }
  if (since) {
    // Legacy explicit since, no watermark yet — do not invent a "now" floor
    // that would hide the window the caller asked for.
    return { after: positionAfterTimestamp(since), watermark: null, since };
  }

  const created = await ensureReadPosition(table, participantId, ORG_EVENT_STREAM, initialPosition(), ctx);
  return { after: created, watermark: created, since: null };
}

async function searchOrgEvents(seekTs: string | null): Promise<AsyncIterable<any>> {
  const table = (databases as any).flair?.OrgEvent;
  if (!table?.search) {
    async function* empty() {}
    return empty();
  }
  const query = seekTs
    ? {
        conditions: [{ attribute: "createdAt", comparator: "greater_than_equal", value: seekTs }],
      }
    : undefined;
  return table.search(query);
}

export class OrgEventCatchup extends Resource {
  // Self-authorize via the Ed25519 agent verify (auth reshape removes the gate's
  // admin elevation). Any verified agent may catch up; participant scoping is in
  // get()/post(). Uses getContext().request — the reliable v5 path (this.request
  // is not populated on Harper v5 Resources).
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  // HarperDB calls get(pathInfo, context) where pathInfo is the URL segment after /OrgEventCatchup/
  async get(pathInfo?: any) {
    // Harper v5 does not populate this.request on Resource subclasses —
    // getContext() is the only reliable path to the gate's tpsAgent/
    // tpsAgentIsAdmin annotations (the previous `(this as
    // any).request` read was always undefined, so the ownership check below
    // never ran — fail-open cross-agent read).
    const auth = await resolveAgentAuth((this as any).getContext?.());
    const ctx = (this as any).getContext?.();

    const participantId = pathParticipantId(pathInfo, this as any);

    if (!participantId) {
      return new Response(
        JSON.stringify({ error: "participantId required in path: GET /OrgEventCatchup/{participantId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Auth: internal calls and admins pass unfiltered; a verified agent may only
    // fetch its own catchup feed; anonymous is denied. allowRead() already
    // blocks anonymous HTTP, but this handler must fail closed on its own too.
    if (ownerDenied(auth, participantId)) return forbidden();

    let resolved: { after: string; watermark: string | null; since: string | null };
    try {
      resolved = await resolveAfter(participantId, pathInfo, ctx);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const pageSize = parsePageSize(queryValue(pathInfo, "limit"));
    const seekTs = catchupSeekTimestamp(resolved.after, resolved.since);
    const ordered = await collectCatchupEvents(await searchOrgEvents(seekTs), {
      participantId,
      after: resolved.after,
      since: resolved.since,
    });
    const paged = pageCatchupEvents(ordered, resolved.after, pageSize);

    return {
      events: paged.page,
      watermark: resolved.watermark,
      after: resolved.after,
      nextAfter: paged.nextAfter,
      hasMore: paged.hasMore,
      pageSize,
    };
  }

  /**
   * Advance-on-ack. Body: `{ position }` (the last delivered event's
   * `position`, or `nextAfter` from a drained page). Monotonic.
   */
  async post(content: any, pathInfo?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    const ctx = (this as any).getContext?.();
    const participantId =
      pathParticipantId(pathInfo, this as any) ??
      (content && typeof content === "object" ? content.participantId ?? content.agentId : null) ??
      null;

    if (!participantId) {
      return new Response(
        JSON.stringify({ error: "participantId required in path: POST /OrgEventCatchup/{participantId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (ownerDenied(auth, participantId)) return forbidden();

    const position = content && typeof content === "object"
      ? String(content.position ?? content.ackThrough ?? "")
      : "";
    if (!position) {
      return new Response(
        JSON.stringify({ error: "position required to ack catch-up (advance-on-ack)" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const result = await advanceReadPosition(
      defaultReadPositionTable(),
      participantId,
      ORG_EVENT_STREAM,
      position,
      ctx,
    );
    return { participantId, stream: ORG_EVENT_STREAM, ...result };
  }
}
