/**
 * team-directory.ts — the ONE team-directory resolver (flair#2141 S3a).
 *
 * Answers "who is in this office, and how do I reach them" from Flair's own
 * records: the active agent-kind principals, joined to their operator-published
 * `tps-mail` `Integration` contact. One resolver serves all three surfaces —
 * the `team_directory` MCP tool, `GET /TeamDirectory`, and the flair client —
 * so they cannot disagree about membership, filtering, caps or error shape.
 *
 * ─── Authority (the directory-specific verified-active-reader gate) ─────────
 * The resolver does NOT go through `Integration`'s owner-only REST scope: it
 * reads the tables in-process (`databases.flair.*`), exactly as bootstrap's
 * roster join does (resources/MemoryBootstrap.ts). Authority is instead the
 * gate below: `resolveAgentAuth` must return a VERIFIED agent — `anonymous`,
 * `internal`, and a MISSING context (which resolves to `internal`) all grant
 * nothing — and a FRESH local `Agent` read must show that same principal as an
 * active agent-kind row. Publication authority is separate: an operator source
 * (resources/Integration.ts) is the only writer of a publication stamp.
 *
 * ─── Unavailable is never a cached success ──────────────────────────────────
 * A failed or unreadable Agent/Integration read returns an explicit
 * `unavailable` refusal (503), never an empty directory. "No teammates" and
 * "the store could not be read" are different answers and must not collapse.
 *
 * ─── Filtering happens BEFORE pagination ────────────────────────────────────
 * Only active agent-kind principals with a matching contact owner, a `tps-mail`
 * platform, and a VALID publication stamp enter the list. Tombstones (a null or
 * absent `directoryPublishedAt`) never do. One channel per agent: a principal
 * with several published `tps-mail` rows contributes the most recently
 * published one.
 *
 * ─── Caps (fixed, applied before anything is returned) ──────────────────────
 *   50 entries per response, one channel per agent, 256 UTF-8 bytes per
 *   returned string, 64 KiB serialized response.
 *
 * Scope note: this slice is LOCAL only. Federation membership (the hub and its
 * directly paired non-relay spokes) and its `Peer.status` vocabulary land in
 * S3b/S3c; `isPeerMemberStatus` (src/lib/peer-status.ts) is the ONE shared
 * vocabulary those slices and the CLI rendering use.
 */

import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { UNAUTH } from "./record-type-kit.js";
import { localInstanceId } from "./instance-identity.js";

/** The platform whose published Integration row is a directory contact. */
export const TEAM_DIRECTORY_PLATFORM = "tps-mail";
/** Maximum entries any single page returns, regardless of a larger `limit`. */
export const TEAM_DIRECTORY_MAX_ENTRIES = 50;
/** Maximum UTF-8 bytes of any returned string (agentId, name, email). */
export const TEAM_DIRECTORY_MAX_STRING_BYTES = 256;
/** Maximum serialized bytes of the whole response. */
export const TEAM_DIRECTORY_MAX_RESPONSE_BYTES = 64 * 1024;
/** Default page size when the caller does not pass `limit`. */
export const TEAM_DIRECTORY_DEFAULT_LIMIT = 50;

export interface TeamDirectoryEntry {
  /** Stable Agent ID. */
  agentId: string;
  /** Display label (the agent's name, else its id). */
  name: string;
  /** The published channel platform (`tps-mail`). */
  platform: string;
  /** The published address. */
  email: string;
  /** The server-stamped publication time. */
  publishedAt: string;
  /** The home instance id, or null when the instance identity is not resolvable. */
  homeInstanceId: string | null;
}

export interface TeamDirectoryResult {
  entries: TeamDirectoryEntry[];
  /** Opaque cursor for the next page, or null when this page is the last. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /** Server-stamped freshness of this page. */
  generatedAt: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function forbidden(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 403, headers: JSON_HEADERS });
}

function unavailable(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 503, headers: JSON_HEADERS });
}

function badLimit(): Response {
  return new Response(JSON.stringify({ error: "invalid_limit" }), { status: 400, headers: JSON_HEADERS });
}

/** UTF-8 byte length of a string. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * A principal is a directory member candidate when its `kind` is absent or
 * `agent` AND its `status` is absent or `active` — the same permissive legacy
 * defaults bootstrap's roster uses (isTeammate, resources/memory-bootstrap-lib.ts):
 * a pre-1.0 row missing either field is a legacy agent/active, never excluded.
 */
export function isActiveAgentPrincipal(record: { id?: unknown; kind?: unknown; status?: unknown } | null | undefined): boolean {
  if (!record || typeof record.id !== "string" || record.id === "") return false;
  if (record.kind !== undefined && record.kind !== "agent") return false;
  if (record.status !== undefined && record.status !== "active") return false;
  return true;
}

/** A publication stamp is valid when it is a non-empty ISO string that parses. */
export function isValidPublicationStamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  return Number.isFinite(Date.parse(value));
}

/** The display label for an agent row: its name, else its id. */
export function agentDisplayName(agent: { id?: unknown; name?: unknown }): string {
  if (typeof agent.name === "string" && agent.name !== "") return agent.name;
  return typeof agent.id === "string" ? agent.id : "";
}

/** Normalize a requested limit to an integer within [1, MAX_ENTRIES]. */
export function normalizeLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return TEAM_DIRECTORY_DEFAULT_LIMIT;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return Math.min(n, TEAM_DIRECTORY_MAX_ENTRIES);
}

/**
 * The verified-active-reader gate. Returns the reader's agent id, or a
 * `Response` refusal. A missing context resolves to `internal` and grants
 * nothing, exactly like anonymous.
 */
export async function resolveDirectoryReader(context: unknown): Promise<{ agentId: string } | Response> {
  const auth = await resolveAgentAuth(context);
  if (auth.kind === "anonymous") return UNAUTH();
  if (auth.kind !== "agent") return forbidden("team_directory_requires_verified_agent");

  let reader: any;
  try {
    reader = await (databases as any).flair.Agent.get(auth.agentId);
  } catch {
    return unavailable("team_directory_unavailable");
  }
  if (!isActiveAgentPrincipal(reader) || reader.id !== auth.agentId) {
    return forbidden("team_directory_reader_not_active");
  }
  return { agentId: auth.agentId };
}

/**
 * Read every directory candidate entry from local records. Returns a `Response`
 * on an unreadable store, never an empty array (unavailable != empty).
 */
async function collectEntries(): Promise<TeamDirectoryEntry[] | Response> {
  const active = new Map<string, any>();
  try {
    for await (const record of (databases as any).flair.Agent.search()) {
      if (isActiveAgentPrincipal(record)) active.set((record as any).id, record);
    }
  } catch {
    return unavailable("team_directory_agent_store_unavailable");
  }

  const byAgent = new Map<string, TeamDirectoryEntry>();
  try {
    for await (const row of (databases as any).flair.Integration.search({
      select: ["agentId", "platform", "email", "directoryPublishedAt"],
    })) {
      const r = row as any;
      if (r.platform !== TEAM_DIRECTORY_PLATFORM) continue;
      if (!isValidPublicationStamp(r.directoryPublishedAt)) continue;
      if (typeof r.email !== "string" || r.email === "") continue;
      const owner = active.get(r.agentId);
      if (!owner) continue; // contact owner must be an active agent-kind principal
      if (utf8Bytes(r.agentId) > TEAM_DIRECTORY_MAX_STRING_BYTES) continue;
      if (utf8Bytes(r.email) > TEAM_DIRECTORY_MAX_STRING_BYTES) continue;
      const entry: TeamDirectoryEntry = {
        agentId: r.agentId,
        name: agentDisplayName(owner),
        platform: r.platform,
        email: r.email,
        publishedAt: r.directoryPublishedAt,
        homeInstanceId: null, // stamped below from the resolved local instance
      };
      // One channel per agent: keep the most recently published row.
      const prev = byAgent.get(entry.agentId);
      if (!prev || entry.publishedAt > prev.publishedAt) byAgent.set(entry.agentId, entry);
    }
  } catch {
    return unavailable("team_directory_contact_store_unavailable");
  }

  return [...byAgent.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** Drop the fewest trailing entries needed to fit the serialized response cap. */
function clampResponse(result: TeamDirectoryResult): TeamDirectoryResult {
  let entries = result.entries;
  while (entries.length > 0 && utf8Bytes(JSON.stringify({ ...result, entries })) > TEAM_DIRECTORY_MAX_RESPONSE_BYTES) {
    entries = entries.slice(0, -1);
  }
  if (entries.length === result.entries.length) return result;
  const last = entries[entries.length - 1];
  return { ...result, entries, nextCursor: last ? last.agentId : null, hasMore: true };
}

export interface TeamDirectoryQuery {
  id?: string;
  name?: string;
  cursor?: string;
  limit?: unknown;
}

/**
 * Resolve a page of the team directory. The caller is responsible for passing
 * a context that resolves to a verified active agent (see
 * `resolveDirectoryReader`); this function enforces it itself, so every surface
 * that shares the resolver shares the gate.
 */
export async function resolveTeamDirectory(
  context: unknown,
  query: TeamDirectoryQuery = {},
): Promise<TeamDirectoryResult | Response> {
  const reader = await resolveDirectoryReader(context);
  if (reader instanceof Response) return reader;

  const limit = normalizeLimit(query.limit);
  if (limit === null) return badLimit();

  const collected = await collectEntries();
  if (collected instanceof Response) return collected;

  const idFilter = typeof query.id === "string" && query.id !== "" ? query.id : null;
  const nameFilter = typeof query.name === "string" && query.name !== "" ? query.name : null;

  let candidates = collected;
  if (idFilter) candidates = candidates.filter((e) => e.agentId === idFilter);
  if (nameFilter) {
    const needle = nameFilter.toLowerCase();
    candidates = candidates.filter((e) => e.name.toLowerCase().includes(needle));
  }

  const cursor = typeof query.cursor === "string" && query.cursor !== "" ? query.cursor : null;
  if (cursor) candidates = candidates.filter((e) => e.agentId > cursor);

  // Reauthorize each page: this call already re-ran the reader gate and the
  // fresh Agent read above, so a revoked reader never receives a later page.
  const page = candidates.slice(0, limit);
  const hasMore = candidates.length > page.length;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].agentId : null;

  const homeInstanceId = await localInstanceId().catch(() => null);
  const entries = page.map((e) => ({ ...e, homeInstanceId }));

  return clampResponse({
    entries,
    nextCursor,
    hasMore,
    limit,
    generatedAt: new Date().toISOString(),
  });
}
