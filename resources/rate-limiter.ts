/**
 * rate-limiter.ts
 *
 * In-memory sliding window rate limiter for Flair endpoints.
 * Configurable via environment variables:
 *
 *   FLAIR_RATE_LIMIT_RPM     — requests per minute per agent (default: 120)
 *   FLAIR_RATE_LIMIT_EMBED   — embedding requests per minute per agent (default: 30)
 *   FLAIR_RATE_LIMIT_STORAGE — max memories per agent (default: 10000)
 *   FLAIR_RATE_LIMIT_ENABLED — "true" to enable (default: disabled for local, enabled when FLAIR_PUBLIC=true)
 */

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();
const WINDOW_MS = 60_000; // 1 minute sliding window
const CLEANUP_INTERVAL_MS = 300_000; // Clean stale entries every 5 minutes

// Default limits (generous for local use)
function getLimit(envVar: string, defaultVal: number): number {
  const val = process.env[envVar];
  return val ? Number(val) : defaultVal;
}

function isEnabled(): boolean {
  if (process.env.FLAIR_RATE_LIMIT_ENABLED === "true") return true;
  if (process.env.FLAIR_PUBLIC === "true") return true;
  return false;
}

/**
 * Check if an agent has exceeded their rate limit for a given bucket.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
export function checkRateLimit(
  agentId: string,
  bucket: "general" | "embedding" = "general",
): { allowed: boolean; retryAfterMs?: number; remaining?: number } {
  if (!isEnabled()) return { allowed: true };
  if (!agentId) return { allowed: true }; // admin/internal calls

  const limit = bucket === "embedding"
    ? getLimit("FLAIR_RATE_LIMIT_EMBED", 30)
    : getLimit("FLAIR_RATE_LIMIT_RPM", 120);

  const key = `${agentId}:${bucket}`;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let entry = windows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(key, entry);
  }

  // Prune old timestamps
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= limit) {
    // Find when the oldest will expire
    const oldest = entry.timestamps[0];
    const retryAfterMs = oldest + WINDOW_MS - now;
    return {
      allowed: false,
      retryAfterMs: Math.max(retryAfterMs, 1000),
      remaining: 0,
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    remaining: limit - entry.timestamps.length,
  };
}

/**
 * Check if an agent has exceeded their storage quota.
 * Returns { allowed: true } or { allowed: false }.
 */
export function checkStorageQuota(currentCount: number): { allowed: boolean; limit: number } {
  if (!isEnabled()) return { allowed: true, limit: Infinity };

  const limit = getLimit("FLAIR_RATE_LIMIT_STORAGE", 10000);
  return {
    allowed: currentCount < limit,
    limit,
  };
}

/**
 * Build a 429 Too Many Requests response.
 */
export function rateLimitResponse(retryAfterMs: number, bucket: string): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      message: `Rate limit exceeded for ${bucket} requests. Retry after ${retryAfterSec}s.`,
      retryAfterMs,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    },
  );
}

/**
 * Build a 413 Payload Too Large response for storage quota.
 */
export function storageQuotaResponse(limit: number): Response {
  return new Response(
    JSON.stringify({
      error: "storage_quota_exceeded",
      message: `Storage quota exceeded. Maximum ${limit} memories per agent.`,
      limit,
    }),
    {
      status: 413,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Periodic cleanup of stale window entries
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS * 2;
    for (const [key, entry] of windows) {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) windows.delete(key);
    }
  }, CLEANUP_INTERVAL_MS).unref?.();
}
