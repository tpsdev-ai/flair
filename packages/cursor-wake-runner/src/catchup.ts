/**
 * Owner-scoped OrgEventCatchup access. The participantId is ALWAYS the
 * caller's own agent id — there is no argument that can name another feed
 * (flair#1613 / #1612). The server also refuses a cross-agent read (403).
 */

export interface CatchupPage {
  events?: Array<Record<string, unknown>> | null;
  after?: string | null;
  nextAfter?: string | null;
  watermark?: string | null;
  hasMore?: boolean;
  pageSize?: number;
}

export interface CatchupPort {
  /** GET /OrgEventCatchup/{self} — never another agent's path. */
  drain: (after?: string, limit?: number) => Promise<CatchupPage>;
  /** POST /OrgEventCatchup/{self} { position } — monotonic ack. */
  ack: (position: string) => Promise<void>;
}

export interface FlairRequestClient {
  agentId: string;
  request: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
}

export function catchupPath(agentId: string): string {
  return `/OrgEventCatchup/${encodeURIComponent(agentId)}`;
}

export function catchupGetPath(agentId: string, after?: string, limit?: number): string {
  const path = catchupPath(agentId);
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  if (typeof limit === "number" && Number.isFinite(limit)) {
    params.set("limit", String(Math.trunc(limit)));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Bind a Flair HTTP client to THIS agent's catchup feed. `agentId` is taken
 * from the signed client identity. Callers cannot redirect the path.
 */
export function createCatchupPort(client: FlairRequestClient): CatchupPort {
  const agentId = client.agentId;
  if (!agentId) throw new Error("FLAIR_AGENT_ID is required — the runner drains only its own feed");
  const ackPath = catchupPath(agentId);
  return {
    drain: (after, limit) => client.request<CatchupPage>("GET", catchupGetPath(agentId, after, limit)),
    ack: async (position) => {
      await client.request("POST", ackPath, { position });
    },
  };
}
