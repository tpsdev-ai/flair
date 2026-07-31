/**
 * rate-limit.ts — throttling for the OAuth authorization-server surface and the
 * OAuth-guarded `/mcp` surface.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `/OAuthToken` accepts three grant types on one unauthenticated endpoint;
 * `/OAuthRegister` creates a durable row; `/OAuthAuthorize` mints authorization
 * codes; `/mcp` runs tools for anyone holding a valid token. None of them were
 * throttled. Authentication is not a rate limit: a *valid* token can hammer the
 * tool surface just as effectively as an invalid one can hammer the token
 * endpoint.
 *
 * ── PER-NODE, IN-MEMORY. Say it out loud. ───────────────────────────────────
 * The counter is a process-local Map. Flair runs on Harper Fabric with more than
 * one node behind a GTM, and components hot-reload. So, precisely:
 *
 *   - The EFFECTIVE ceiling is `limit x <number of nodes serving the origin>`,
 *     not `limit`. A caller cannot choose their node, but repeated attempts do
 *     spread across them.
 *   - The counter RESETS on component reload/restart. Reload is operator-
 *     initiated, so this is not something a caller can trigger — but a deploy
 *     does clear every bucket.
 *   - A fixed window admits up to `2 x limit` across a window boundary.
 *
 * The alternative — a Harper table-backed counter — is cluster-visible but is
 * the wrong trade here, and not merely because of latency:
 *
 *   1. A flair table is REPLICATED. Every counted request would become a
 *      durable write fanned out to every node. An attacker sending N requests
 *      would generate N cluster-wide replicated writes. That is write
 *      amplification on the exact hot path the limiter exists to protect — a
 *      strictly worse DoS shape than the one being defended against.
 *   2. Replication is eventually consistent, so the shared counter would not be
 *      accurate for a burst anyway. It would buy correctness at the timescale of
 *      replication lag, which is the timescale a burst has already finished in.
 *
 * And the security value does not hinge on the exact multiplier. This is a
 * BRUTE-FORCE control, not a capacity control: what matters is that the number
 * of guesses per unit time is bounded and small, against secrets with 256 bits
 * of entropy (`randomBytes(32)` — resources/OAuth.ts). Whether the ceiling is
 * 30/min or 60/min is immaterial to that; whether it is bounded at all is not.
 *
 * WHAT WOULD CHANGE THIS ANSWER: a guessable-secret space small enough that a
 * small constant multiplier matters; a node count large enough that `limit x N`
 * stops being meaningfully bounded; or Harper gaining a shared, NON-replicated
 * cache primitive (a counter that is cluster-visible without becoming durable
 * replicated storage), at which point the per-node argument stops being the
 * honest one.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST, stated plainly:
 *   - A distributed botnet. Per-IP keying is defeated by enough distinct source
 *     addresses; nothing here changes that.
 *   - Aggregate cluster capacity. This is a per-node, per-key control.
 *   - Anything at all if the operator sets `FLAIR_RATE_LIMIT=off`.
 *
 * ── The counter is consumed BEFORE any credential is looked at ──────────────
 * `checkHttpRateLimit` runs at the top of auth-middleware, before the request
 * body is parsed and before any grant, code, secret or token is evaluated. That
 * is deliberate and it is a security property, not an implementation detail: if
 * the limiter only counted FAILURES, then "did this attempt consume budget"
 * would answer "was that credential valid" — an enumeration oracle strictly
 * better than the 400 the endpoint already returns. Counting unconditionally
 * means a 429 carries no information about the credential that accompanied it,
 * and a valid credential and a garbage one are byte-identical once limited.
 *
 * For the same reason nothing here emits `RateLimit-Limit`/`RateLimit-Remaining`
 * on a request that was ALLOWED. Those headers are conventional and harmless on
 * an ordinary API; on a credential endpoint they hand a caller a free pacing
 * oracle for staying just under the threshold. `Retry-After` on the 429 itself
 * is the one hint we give, because a client that cannot back off correctly is a
 * client that retries in a tight loop.
 */

// ─── Configuration ──────────────────────────────────────────────────────────

/** One-shot log guard — a warning per request would be its own amplification. */
const warnedOnce = new Set<string>();
function warnOnce(tag: string, message: string): void {
  if (warnedOnce.has(tag)) return;
  warnedOnce.add(tag);
  console.error(`[rate-limit] ${message}`);
}

/** Test-only: forget which one-shot warnings have fired. */
export function __resetWarningsForTest(): void {
  warnedOnce.clear();
}

/**
 * Master switch. Enabled unless `FLAIR_RATE_LIMIT` is exactly `off`/`0`/`false`
 * (case-insensitive). Deliberately opt-OUT: a limiter that has to be discovered
 * and switched on is a limiter that is off on every instance that most needs it.
 *
 * An unrecognised value is treated as ENABLED and warned about, so a typo
 * (`FLAIR_RATE_LIMIT=disabled`) cannot silently disable the control.
 */
export function rateLimitEnabled(): boolean {
  const raw = (process.env.FLAIR_RATE_LIMIT ?? "").trim().toLowerCase();
  if (raw === "") return true;
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") {
    warnOnce("disabled", "DISABLED by FLAIR_RATE_LIMIT — the OAuth and /mcp surfaces are unthrottled.");
    return false;
  }
  if (raw === "on" || raw === "1" || raw === "true" || raw === "yes") return true;
  warnOnce(
    "bad-master",
    `FLAIR_RATE_LIMIT is set to an unrecognised value — keeping rate limiting ENABLED. ` +
      `Use FLAIR_RATE_LIMIT=off to disable it.`,
  );
  return true;
}

/**
 * Read a positive-integer limit from the environment, falling back to `dflt`.
 *
 * Zero and negatives are REJECTED rather than honoured. A limit of 0 would mean
 * "reject everything", which is not a rate limit an operator arrives at by
 * intent — it is what a shell that expanded an unset variable produces. Every
 * rejection is warned about by NAME so a typo is visible rather than silently
 * swapped for the default.
 */
export function envLimit(name: string, dflt: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    warnOnce(`bad-limit:${name}`, `${name} is not a positive integer — using the default of ${dflt}.`);
    return dflt;
  }
  return n;
}

export interface Policy {
  /**
   * Bucket name — part of the key, so paths sharing a bucket share one budget.
   *
   * `/OAuthToken`, `/OAuthAuthorize` and `/OAuthRevoke` deliberately SHARE the
   * `oauth` bucket. They are one credential surface: a caller working through
   * codes, refresh tokens and revocations is making one run of attempts, and
   * bounding the total is tighter than bounding each separately, which would
   * hand the same caller three times the budget for the same activity. Nor
   * would splitting protect anyone from anyone else — the key is the caller
   * either way, so the party a split would isolate is the party from itself.
   *
   * `/OAuthRegister` gets its own, much tighter bucket: it is a different kind
   * of abuse (durable, replicated rows) at a different natural rate (once per
   * client, ever), so folding it in would either loosen the registration limit
   * or throttle ordinary token traffic down to a registration-shaped rate.
   */
  readonly bucket: string;
  /** Requests permitted per window. */
  readonly limit: number;
  /** Window length in ms. */
  readonly windowMs: number;
}

/**
 * Limits, and why each number.
 *
 * `/OAuthToken`, `/OAuthAuthorize`, `/OAuthRevoke` — 30 per minute per caller.
 * A real authorization flow is a handful of requests per user per hour: one
 * authorize, one code exchange, one refresh per access-token lifetime (1 hour,
 * resources/OAuth.ts). 30/min leaves roughly two orders of magnitude of headroom
 * over legitimate use while capping a guessing run at 1800/hour/node against a
 * 256-bit space.
 *
 * `/OAuthRegister` — 5 per five minutes. Registration is a once-per-client
 * event, and each one creates a durable, replicated row. This is the table-
 * pollution ceiling. (Registration is additionally gated; see the DCR work.)
 *
 * `/mcp` — 120 per minute per verified token subject. An agent doing real work
 * makes many tool calls in a burst; this is sized to be invisible to genuine use
 * and to stop one token from monopolising the surface.
 */
export function policyFor(bucket: "oauth" | "register" | "mcp"): Policy {
  switch (bucket) {
    case "register":
      return { bucket: "register", limit: envLimit("FLAIR_OAUTH_REGISTER_RATE_LIMIT", 5), windowMs: 300_000 };
    case "mcp":
      return { bucket: "mcp", limit: envLimit("FLAIR_MCP_RATE_LIMIT", 120), windowMs: 60_000 };
    case "oauth":
    default:
      return { bucket: "oauth", limit: envLimit("FLAIR_OAUTH_RATE_LIMIT", 30), windowMs: 60_000 };
  }
}

/** Paths this module throttles, and which policy each uses. Nothing else is touched. */
const PATH_POLICY: Record<string, "oauth" | "register"> = {
  "/OAuthToken": "oauth",
  "/OAuthAuthorize": "oauth",
  "/OAuthRevoke": "oauth",
  "/OAuthRegister": "register",
};

/**
 * Which policy applies to a pathname, or null for "not throttled".
 *
 * Exact match only. A prefix test would pull in unrelated sibling routes, and
 * the OAuth endpoints are addressed by their exact resource path.
 */
export function policyForPath(pathname: string): Policy | null {
  const kind = PATH_POLICY[pathname];
  return kind ? policyFor(kind) : null;
}

// ─── The counter ────────────────────────────────────────────────────────────

interface Bucket {
  /** Start of the current fixed window, ms epoch. */
  windowStart: number;
  /** Requests counted in the current window, including the one being decided. */
  count: number;
}

/**
 * Hard cap on tracked keys. Without one, a caller rotating source addresses
 * turns the limiter itself into a memory-exhaustion primitive — the classic way
 * a rate limiter becomes the DoS. 20 000 entries is far above any legitimate key
 * count for a single instance and costs on the order of a megabyte.
 *
 * Eviction is LRU (see `consume`: a touched key is re-inserted at the back of
 * the Map). That ordering matters and is the right way round: a caller hammering
 * one key keeps it hot, so it is the LAST thing evicted and stays limited; the
 * entries evicted under pressure are idle ones, which had unspent budget anyway.
 *
 * Named trade-off: at the cap, an evicted key gets a fresh budget. Bounded
 * memory is worth more than a perfectly-retained counter, and a caller able to
 * fill 20 000 distinct keys is already distributed across 20 000 sources, which
 * per-key limiting was never the control for.
 */
export const MAX_TRACKED_KEYS = 20_000;

const buckets = new Map<string, Bucket>();

/** Test-only: drop all counters so cases don't inherit each other's state. */
export function __resetBucketsForTest(): void {
  buckets.clear();
}

/** Test-only: how many keys are currently tracked. */
export function __trackedKeyCountForTest(): number {
  return buckets.size;
}

export interface Decision {
  /** True = over the limit, reject. */
  limited: boolean;
  /** The configured limit that was applied. */
  limit: number;
  /** Seconds until the current window ends (>= 1). */
  retryAfterSec: number;
}

/**
 * Count one request against `key` and decide.
 *
 * ALWAYS consumes, including when the answer is "limited" — a caller that keeps
 * hammering keeps the window pinned rather than trickling through at exactly the
 * limit. Callers must invoke this before evaluating any credential; see the
 * module header for why that is a security property.
 */
export function consume(key: string, policy: Policy, now: number = Date.now()): Decision {
  const existing = buckets.get(key);

  let bucket: Bucket;
  if (!existing || now - existing.windowStart >= policy.windowMs) {
    bucket = { windowStart: now, count: 1 };
  } else {
    bucket = { windowStart: existing.windowStart, count: existing.count + 1 };
  }

  // delete-then-set moves the key to the back of the Map's insertion order,
  // which is what makes the eviction below LRU rather than first-seen.
  buckets.delete(key);
  buckets.set(key, bucket);

  if (buckets.size > MAX_TRACKED_KEYS) evictOldest(now, policy.windowMs);

  const elapsed = now - bucket.windowStart;
  return {
    limited: bucket.count > policy.limit,
    limit: policy.limit,
    retryAfterSec: Math.max(1, Math.ceil((policy.windowMs - elapsed) / 1000)),
  };
}

/**
 * Bring the Map back under the cap: drop expired windows first (they carry no
 * information), then the least-recently-used entries.
 *
 * Not a periodic sweep. A timer in a Harper component outlives nothing useful
 * and has to be torn down on reload; doing the work only when the cap is
 * actually reached keeps the steady state at zero cost.
 */
function evictOldest(now: number, windowMs: number): void {
  for (const [k, b] of buckets) {
    if (buckets.size <= MAX_TRACKED_KEYS) break;
    if (now - b.windowStart >= windowMs) buckets.delete(k);
  }
  for (const k of buckets.keys()) {
    if (buckets.size <= MAX_TRACKED_KEYS) break;
    buckets.delete(k);
  }
}

// ─── Caller identity ────────────────────────────────────────────────────────

/**
 * How many proxy hops in front of this instance are trusted, or 0 for "none".
 *
 * `FLAIR_TRUSTED_PROXY` — unset/`0` means the socket peer address is the only
 * thing used. A positive integer N means the instance genuinely sits behind N
 * trusted reverse proxies that append to `X-Forwarded-For`.
 *
 * DEFAULT OFF, and that direction is the point: `X-Forwarded-For` is a request
 * header, so an instance that trusts it without a proxy in front lets any caller
 * mint a fresh bucket per request by rotating the header — a limiter that is
 * bypassable by anyone who has read this file. Trusting it has to be a decision
 * an operator makes about their own topology.
 */
export function trustedProxyHops(): number {
  const raw = (process.env.FLAIR_TRUSTED_PROXY ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "off" || raw === "false" || raw === "no") return 0;
  if (raw === "on" || raw === "true" || raw === "yes") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    warnOnce("bad-proxy", `FLAIR_TRUSTED_PROXY is not a non-negative integer — treating it as 0 (no proxy trusted).`);
    return 0;
  }
  return n;
}

/** Sentinel used when no caller address can be determined. See `callerKey`. */
export const UNKNOWN_CALLER = "addr:unknown";

/**
 * The rate-limit key component identifying the caller.
 *
 * Sources, in order:
 *  1. `X-Forwarded-For`, but ONLY when `FLAIR_TRUSTED_PROXY` is set, and then
 *     the entry `hops` from the RIGHT — never the leftmost. Each proxy appends
 *     the peer it saw, so the rightmost entries are the ones written by the
 *     trusted hops; the leftmost is whatever the original caller chose to send
 *     and is worth nothing. Taking the left entry is the classic way this
 *     control is made bypassable.
 *  2. Harper's `request.ip` — the socket peer address. On a Fabric UDS listener
 *     Harper substitutes the real client address from the PROXY v1 header when
 *     one is present (harper/dist/server/http.js).
 *  3. `UNKNOWN_CALLER`, warned about once.
 *
 * Step 3 collapses every caller into ONE bucket, which is deliberately the
 * fail-SAFE direction — over-restrictive, never unthrottled. It is also loud:
 * silently not limiting would be an unrun check that looks like a pass, and an
 * operator who never learns the limiter degraded cannot fix it.
 */
export function callerKey(request: any): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const raw =
      request?.headers?.get?.("x-forwarded-for") ??
      request?.headers?.asObject?.["x-forwarded-for"] ??
      "";
    if (typeof raw === "string" && raw.trim() !== "") {
      const parts = raw.split(",").map((s: string) => s.trim()).filter(Boolean);
      // The trusted hops appended the last `hops` entries; the one the nearest
      // trusted proxy observed as its own peer sits at length - hops.
      const idx = parts.length - hops;
      if (idx >= 0 && parts[idx]) return `xff:${parts[idx]}`;
      // Fewer entries than trusted hops: the chain is shorter than configured, so
      // no entry in it was written by a trusted hop. Fall through to the socket
      // peer rather than trust a caller-supplied value.
    }
  }

  const ip = request?.ip;
  if (typeof ip === "string" && ip !== "") return `addr:${ip}`;

  warnOnce(
    "no-addr",
    "no client address available on the request — every caller now shares ONE bucket per endpoint, " +
      "which throttles more than intended. If this instance sits behind a reverse proxy that sets " +
      "X-Forwarded-For, set FLAIR_TRUSTED_PROXY to the number of trusted hops.",
  );
  return UNKNOWN_CALLER;
}

// ─── Responses ──────────────────────────────────────────────────────────────

/**
 * The 429 body. Identical for every endpoint, every key and every grant type,
 * and it echoes nothing back — no client_id, no address, no grant type, no
 * remaining count. `slow_down` is a real OAuth error code (RFC 8628 s3.5) and
 * means exactly this, so a spec-aware client already knows what to do with it.
 */
export const LIMITED_BODY = JSON.stringify({
  error: "slow_down",
  error_description: "too many requests",
});

export function limitedHeaders(decision: Decision): Record<string, string> {
  return {
    "content-type": "application/json",
    "retry-after": String(decision.retryAfterSec),
    // Do not add RateLimit-Limit/Remaining here or on the success path; see the
    // module header on why a pacing oracle is not wanted on a credential endpoint.
    "cache-control": "no-store",
  };
}

/** A 429 as a `Response` — for the default dispatch chain (auth-middleware). */
export function limitedResponse(decision: Decision): Response {
  return new Response(LIMITED_BODY, { status: 429, headers: limitedHeaders(decision) });
}

// ─── Entry points ───────────────────────────────────────────────────────────

/**
 * The auth-middleware hook. Returns a 429 `Response` to short-circuit with, or
 * null to continue.
 *
 * Must be called before the public-path passthrough and before anything reads
 * the body: the three OAuth endpoints this covers all sit on that passthrough,
 * so a hook placed after it would never run for them.
 */
export function checkHttpRateLimit(request: any, pathname: string): Response | null {
  if (!rateLimitEnabled()) return null;
  const policy = policyForPath(pathname);
  if (!policy) return null;

  const decision = consume(`${policy.bucket}|${callerKey(request)}`, policy);
  return decision.limited ? limitedResponse(decision) : null;
}

/**
 * The `/mcp` hook. Keyed on the RS256-verified token subject (and `client_id`
 * when present), never on an address: `/mcp` is authenticated, so the strongest
 * available identity is the one the authorization server signed. That also makes
 * this limit survive a caller changing address, which per-IP keying does not.
 *
 * Returns a Harper listener result (`{ status, body, headers }`) to short-circuit
 * with, or null to continue. Runs INSIDE `withMCPAuth`, so `request.mcp` is
 * populated; an unverified request never reaches here because the guard fails
 * closed ahead of it.
 */
export function checkMcpRateLimit(request: any): { status: number; body: string; headers: Record<string, string> } | null {
  if (!rateLimitEnabled()) return null;
  const policy = policyFor("mcp");

  const sub = typeof request?.mcp?.sub === "string" ? request.mcp.sub : "";
  const clientId = typeof request?.mcp?.client_id === "string" ? request.mcp.client_id : "";
  // No verified subject should be impossible here (withMCPAuth fails closed), but
  // if it ever were, fall back to the caller address rather than to no limit.
  const identity = sub ? `sub:${sub}|cid:${clientId}` : callerKey(request);

  const decision = consume(`${policy.bucket}|${identity}`, policy);
  if (!decision.limited) return null;
  return {
    status: 429,
    headers: limitedHeaders(decision),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32029, message: "too many requests" },
    }),
  };
}
