/**
 * catchup.ts — pure helpers for the flair_catchup stdio binding (flair#1583).
 *
 * Owner-scope is enforced BY CONSTRUCTION: the participantId in the request
 * path is always the caller's own agentId (from `FLAIR_AGENT_ID` / the signed
 * identity), never a tool argument. The descriptor advertises no `agentId` /
 * `participantId` property, so there is nothing to name another agent's feed
 * with — and the server independently refuses a cross-agent read (403). This
 * module is HTTP-/Harper-free (plain helpers + types) so the flair-mcp
 * package stays FlairClient-only.
 */

/**
 * `GET /OrgEventCatchup/{participantId}` response shape
 * (resources/OrgEventCatchup.ts). `position` is stamped onto every event
 * (see org-event-catchup-lib.ts `withEventPosition`), and is what a caller
 * passes back as `ack` once it has processed the event.
 */
export interface CatchupPage {
  events?: Array<Record<string, unknown>> | null;
  /** Resolved exclusive cursor this page was read after. */
  after?: string | null;
  /** Cursor to continue a drain — the last event's position (or `after` when the page is empty). */
  nextAfter?: string | null;
  /** Durable watermark at read time (null when the caller has none yet). */
  watermark?: string | null;
  hasMore?: boolean;
  pageSize?: number;
}

export interface CatchupArgs {
  after?: unknown;
  limit?: unknown;
  ack?: unknown;
}

export interface CatchupRequest {
  /** Owner-scoped base path — the caller's own participantId. */
  path: string;
  /** GET path (base + optional query). */
  getPath: string;
  /** POST path for the ack (same owner-scoped base). */
  ackPath: string;
  /** Non-empty ack position, or null when the caller did not ack. */
  ackPosition: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build the owner-scoped catchup request from tool args. `participantId` is
 * ALWAYS `agentId` — the args cannot redirect it.
 */
export function buildCatchupRequest(agentId: string, args: CatchupArgs): CatchupRequest {
  const path = `/OrgEventCatchup/${encodeURIComponent(agentId)}`;

  const params = new URLSearchParams();
  const after = nonEmptyString(args.after);
  if (after) params.set("after", after);
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
    params.set("limit", String(Math.trunc(args.limit)));
  }
  const query = params.toString();

  return {
    path,
    getPath: query ? `${path}?${query}` : path,
    ackPath: path,
    ackPosition: nonEmptyString(args.ack),
  };
}

export interface CatchupSummary {
  text: string;
  structuredContent: Record<string, unknown>;
}

/**
 * Project a catchup page into the caller-facing text summary plus the
 * structured echo (the machine-readable payload). Never throws on a
 * malformed/absent page — it degrades to "no new events".
 */
export function summarizeCatchup(page: CatchupPage | undefined, acked: string | null): CatchupSummary {
  const events = Array.isArray(page?.events) ? (page?.events as Array<Record<string, unknown>>) : [];
  const after = page?.after ?? null;
  const nextAfter = page?.nextAfter ?? after;
  const watermark = page?.watermark ?? null;
  const hasMore = page?.hasMore === true;
  const pageSize = page?.pageSize;

  const header =
    events.length === 0
      ? `Catchup: no new events after ${after ?? "(your watermark)"}.`
      : `Catchup: ${events.length} event(s) after ${after ?? "(your watermark)"}${hasMore ? " (more available)" : ""}.`;

  const lines = events.map((event, index) => {
    const kind = typeof event.kind === "string" ? event.kind : "?";
    const summary = typeof event.summary === "string" ? event.summary : "";
    const id = typeof event.id === "string" ? `id:${event.id}` : "";
    const position = typeof event.position === "string" ? `position:${event.position}` : "";
    const targets =
      Array.isArray(event.targetIds) && event.targetIds.length > 0
        ? `targets:${(event.targetIds as string[]).join(",")}`
        : "";
    const meta = [id, position, targets].filter(Boolean).join(", ");
    return `${index + 1}. [${kind}] ${summary}${meta ? ` (${meta})` : ""}`;
  });

  const cursorLines: string[] = [];
  if (nextAfter) cursorLines.push(`nextAfter: ${nextAfter}`);
  if (acked) cursorLines.push(`acked: ${acked}`);
  if (nextAfter) {
    cursorLines.push(
      hasMore
        ? `More available — page again with after="${nextAfter}", then ack="${nextAfter}" once drained.`
        : `Ack with ack="${nextAfter}" once you have processed these events to advance your watermark.`,
    );
  }

  const body = [header, ...lines, ...(cursorLines.length > 0 ? ["", ...cursorLines] : [])].join("\n");

  const structuredContent: Record<string, unknown> = {
    events,
    after,
    nextAfter,
    watermark,
    hasMore,
  };
  if (typeof pageSize === "number") structuredContent.pageSize = pageSize;
  if (acked) structuredContent.acked = acked;

  return { text: body, structuredContent };
}
