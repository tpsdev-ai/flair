/**
 * Action recall (flair#2067 slice 2) — the SessionStart refresh.
 *
 * Rebuilds the reader-specific cache of the agent's OWN lessons through the
 * ordinary signed read path at session start.
 *
 * Basic fallback is disabled; an unsigned request is refused by the server.
 * Refresh requires bootstrap scope naming the configured agent with
 * `isAdmin === false`.
 */

import {
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  CACHE_VERSION,
  CONTENT_SKIP_BYTES,
  buildExcerpt,
  encodeEnvelope,
  readTriggerMetadata,
  redactLabel,
  utf8Bytes,
  type ActionTrigger,
  type CacheEntry,
  type CachePayload,
} from "./action-recall.js";
import {
  acquireRefreshLock,
  cleanupOldGenerations,
  invalidateBinding,
  pruneSessionCaches,
  publishGeneration,
  resolveCacheRoot,
  sessionDir,
} from "./action-recall-cache.js";

/** Reads and publication are deadline checked from refresh start. */
export const REFRESH_DEADLINE_MS = 3000;
/** Response-byte cap for the bounded Memory read (8 MiB). */
export const REFRESH_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Newest own lesson candidates fetched before eligibility. */
export const REFRESH_CANDIDATES = 256;

/** The fields this refresh reads off each row. The server returns full rows to
 *  a non-admin read regardless; the select is explicit about intent. */
export const REFRESH_SELECT = [
  "id",
  "agentId",
  "type",
  "content",
  "createdAt",
  "updatedAt",
  "validFrom",
  "validTo",
  "expiresAt",
  "visibility",
  "provenance",
  "archived",
  "metadata",
  "_safetyFlags",
] as const;

export interface ActionRecallRefreshClient {
  bootstrap(opts: {
    maxTokens?: number;
    channel?: string;
    subjects?: string[];
  }): Promise<{ scope?: { agentId?: string; isAdmin?: boolean } } | undefined>;
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { signal?: AbortSignal; maxResponseBytes?: number },
  ): Promise<T>;
}

export interface RefreshOptions {
  agentId: string;
  url: string;
  session: string;
  /** The bootstrap result the caller already has (for its scope). */
  bootstrapResult?: { scope?: { agentId?: string; isAdmin?: boolean } } | undefined;
  env?: NodeJS.ProcessEnv;
  now?: number;
  root?: string;
  deadlineMs?: number;
}

export interface RefreshResult {
  ok: boolean;
  reason?: string;
  generation?: string;
  entries?: number;
}

interface MemoryRow {
  id?: unknown;
  agentId?: unknown;
  type?: unknown;
  content?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  expiresAt?: unknown;
  visibility?: unknown;
  provenance?: unknown;
  archived?: unknown;
  metadata?: unknown;
  _safetyFlags?: unknown;
}

/** Harper collection path for the bounded own-lesson read. */
export function memoryRecallPath(agentId: string): string {
  const select = REFRESH_SELECT.join(",");
  return `/Memory?agentId=${encodeURIComponent(agentId)}&type=lesson&select(${select})&sort(-createdAt)&limit(0,${REFRESH_CANDIDATES})`;
}

function parseStamp(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function rowEligible(row: MemoryRow, now: number): boolean {
  if (row.type !== "lesson") return false;
  if (row.archived === true) return false;
  if (typeof row.content !== "string") return false;
  if (utf8Bytes(row.content) > CONTENT_SKIP_BYTES) return false;
  if (Array.isArray(row._safetyFlags) && row._safetyFlags.length > 0) return false;
  const expiresAt = parseStamp(row.expiresAt);
  if (expiresAt !== null && expiresAt <= now) return false;
  const validTo = parseStamp(row.validTo);
  if (validTo !== null && validTo <= now) return false;
  const validFrom = parseStamp(row.validFrom);
  if (validFrom !== null && validFrom > now) return false;
  return true;
}

/** Turn one eligible row into a cache entry, or null when it has no valid triggers. */
export function rowToEntry(row: MemoryRow, agentId: string): CacheEntry | null {
  if (typeof row.id !== "string" || row.id === "") return null;
  if (row.agentId !== agentId) return null;
  const metadata = readTriggerMetadata(typeof row.metadata === "string" ? row.metadata : null);
  if (!metadata.ok) return null; // absent or invalid: no triggers, ineligible
  const triggers: ActionTrigger[] = metadata.triggers;
  if (triggers.length === 0) return null; // no triggers means no recall
  const content = typeof row.content === "string" ? row.content : "";
  return {
    id: row.id,
    owner: agentId,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    validFrom: typeof row.validFrom === "string" ? row.validFrom : undefined,
    validTo: typeof row.validTo === "string" ? row.validTo : undefined,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : undefined,
    visibility: typeof row.visibility === "string" ? row.visibility : undefined,
    provenance: typeof row.provenance === "string" ? redactLabel(row.provenance) : undefined,
    safetyFlags: [],
    triggers,
    excerpt: buildExcerpt(content),
  };
}

/** Newest-first by createdAt, ties by id, then cap and trim whole entries to fit. */
export function assemblePayload(
  entries: CacheEntry[],
  bindings: { url: string; principal: string; session: string; instance: string; generation: string },
  refreshStart: number,
  expiry: number,
): CachePayload {
  const sorted = [...entries].sort((a, b) => {
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    if (ca !== cb) return ca < cb ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  let selected = sorted.slice(0, CACHE_MAX_ENTRIES);
  let payload: CachePayload = { v: CACHE_VERSION, ...bindings, refreshStart, expiry, entries: selected };
  while (selected.length > 0 && utf8Bytes(encodeEnvelope(payload)) > CACHE_MAX_BYTES) {
    selected = selected.slice(0, -1);
    payload = { ...payload, entries: selected };
  }
  return payload;
}

/** The unique instance identity: exactly one row with a non-empty string id. */
export function singleInstanceId(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0] as { id?: unknown } | null;
  if (!row || typeof row.id !== "string" || row.id === "") return null;
  return row.id;
}

export async function refreshActionRecallCache(
  client: ActionRecallRefreshClient,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const root = opts.root ?? resolveCacheRoot(env);
  const deadlineMs = opts.deadlineMs ?? REFRESH_DEADLINE_MS;
  const deadlineAt = performance.now() + deadlineMs;

  const scope = opts.bootstrapResult?.scope;
  if (!scope || scope.agentId !== opts.agentId || scope.isAdmin !== false) {
    return { ok: false, reason: "scope" };
  }

  const dir = sessionDir(root, opts.url, opts.agentId, opts.session);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);
  timer.unref?.();

  const release = await acquireRefreshLock(dir);
  if (!release) {
    clearTimeout(timer);
    return { ok: false, reason: "locked" };
  }

  try {
    await invalidateBinding(dir);

    const instances = await client.request<unknown>("GET", "/Instance", undefined, {
      signal: controller.signal,
      maxResponseBytes: REFRESH_MAX_RESPONSE_BYTES,
    });
    const instance = singleInstanceId(instances);
    if (!instance) return { ok: false, reason: "instance" };

    const rows = await client.request<unknown>("GET", memoryRecallPath(opts.agentId), undefined, {
      signal: controller.signal,
      maxResponseBytes: REFRESH_MAX_RESPONSE_BYTES,
    });
    const list: unknown = Array.isArray(rows) ? rows : (rows as { results?: unknown } | null)?.results;
    if (!Array.isArray(list) || list.some(row =>
      typeof row !== "object" || row === null || Array.isArray(row) ||
      typeof row.id !== "string" || typeof row.agentId !== "string" || typeof row.content !== "string"
    )) {
      return { ok: false, reason: "response" };
    }
    // Independent recheck: ownership and eligibility, on the rows we selected.
    const entries: CacheEntry[] = [];
    for (const row of list) {
      if (row.agentId !== opts.agentId) continue;
      if (!rowEligible(row, now)) continue;
      const entry = rowToEntry(row, opts.agentId);
      if (entry) entries.push(entry);
    }

    if (timedOut) return { ok: false, reason: "timeout" };

    const refreshStart = now;
    const generation = `${refreshStart.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const payload = assemblePayload(
      entries,
      { url: opts.url, principal: opts.agentId, session: opts.session, instance, generation },
      refreshStart,
      refreshStart + 5 * 60 * 1000,
    );
    if (timedOut) return { ok: false, reason: "timeout" };
    const published = await publishGeneration(dir, payload, { signal: controller.signal, deadlineAt });
    if (!published.ok) return { ok: false, reason: published.reason ?? "publish" };
    await cleanupOldGenerations(dir, instance, generation);
    await pruneSessionCaches(root, opts.url, opts.agentId);
    return { ok: true, generation, entries: payload.entries.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.name : "error" };
  } finally {
    clearTimeout(timer);
    await release();
  }
}
