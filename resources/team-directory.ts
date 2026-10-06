/**
 * team-directory.ts — the ONE team-directory resolver (flair#2141 S3a).
 *
 * Answers "who is in this office, and how do I reach them" from Flair's own
 * records: the active agent-kind principals, joined to their published
 * `tps-mail` `Integration` contact. One resolver serves the `team_directory`
 * MCP tool, `GET /TeamDirectory` and the flair client.
 *
 * ─── Authority (the directory-specific verified-active-reader gate) ─────────
 * The resolver does NOT go through `Integration`'s owner-only REST scope: it
 * reads the tables in-process (`databases.flair.*`), exactly as bootstrap's
 * roster join does (resources/MemoryBootstrap.ts). Authority is instead the
 * gate below: `resolveAgentAuth` must return a VERIFIED agent — `anonymous`,
 * `internal`, and a MISSING context (which resolves to `internal`) all grant
 * nothing — and a FRESH local `Agent` read must show that same principal as an
 * active agent-kind row.
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
 * published one, compared by publication time in epoch milliseconds rather
 * than as strings (a stored stamp may be any parseable date string).
 *
 * ─── Caps (fixed, applied before anything is returned) ──────────────────────
 *   50 entries per response, one channel per agent, 256 UTF-8 bytes for
 *   agentId, name and email, 64 KiB serialized response.
 *
 * Scope note: this slice is LOCAL only and reads no Peer rows, so it does not
 * call `isPeerMemberStatus` (src/lib/peer-status.ts); federation membership
 * lands in S3b/S3c.
 */

import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { UNAUTH } from "./record-type-kit.js";
import { localInstanceId } from "./instance-identity.js";

/** The platform whose published Integration row is a directory contact. */
export const TEAM_DIRECTORY_PLATFORM = "tps-mail";
/** Maximum entries any single page returns, regardless of a larger `limit`. */
export const TEAM_DIRECTORY_MAX_ENTRIES = 50;
/** Maximum UTF-8 bytes of agentId, name and email. */
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
  /** The stored publication time, normalized to ISO. */
  publishedAt: string;
  /** The home instance id, or null when the instance identity is not resolvable. */
  homeInstanceId: string | null;
}

export interface TeamDirectoryResult {
  entries: TeamDirectoryEntry[];
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

/** Missing kind/status fields retain legacy agent/active compatibility. */
export function isActiveAgentPrincipal(record: { id?: unknown; kind?: unknown; status?: unknown } | null | undefined): boolean {
  if (!record || typeof record.id !== "string" || record.id === "") return false;
  if (record.kind !== undefined && record.kind !== "agent") return false;
  if (record.status !== undefined && record.status !== "active") return false;
  return true;
}

/** A publication stamp is valid when it is a parseable date string. */
export function isValidPublicationStamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  return Number.isFinite(Date.parse(value));
}

/** Cut `value` to at most `max` UTF-8 bytes without splitting a code point. */
export function cutToUtf8Bytes(value: string, max: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= max) return value;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
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
 * on an unreadable store.
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
  const byAgentTimeMs = new Map<string, number>();
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
      // Normalize the publication time to epoch milliseconds before choosing
      // the most recent: a stored stamp may be any parseable date string, and
      // string order is not time order ("10/03/2026" sorts before "2026-10-01").
      const publishedMs = Date.parse(r.directoryPublishedAt);
      const entry: TeamDirectoryEntry = {
        agentId: r.agentId,
        name: cutToUtf8Bytes(agentDisplayName(owner), TEAM_DIRECTORY_MAX_STRING_BYTES),
        platform: r.platform,
        email: r.email,
        publishedAt: new Date(publishedMs).toISOString(),
        homeInstanceId: null, // stamped below from the resolved local instance
      };
      // One channel per agent: keep the most recently published row.
      const prevMs = byAgentTimeMs.get(entry.agentId);
      if (prevMs === undefined || publishedMs > prevMs) {
        byAgent.set(entry.agentId, entry);
        byAgentTimeMs.set(entry.agentId, publishedMs);
      }
    }
  } catch {
    return unavailable("team_directory_contact_store_unavailable");
  }

  return [...byAgent.values()].sort((a, b) => compareAgentIds(a.agentId, b.agentId));
}

function compareAgentIds(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Drop the fewest trailing entries needed to fit the serialized response cap. */
function clampResponse(result: TeamDirectoryResult): TeamDirectoryResult {
  while (result.entries.length > 0 && utf8Bytes(JSON.stringify(result)) > TEAM_DIRECTORY_MAX_RESPONSE_BYTES) {
    const entries = result.entries.slice(0, -1);
    result = { ...result, entries, nextCursor: entries.at(-1)?.agentId ?? null, hasMore: true };
  }
  return result;
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
  if (cursor) candidates = candidates.filter((e) => compareAgentIds(e.agentId, cursor) > 0);

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
