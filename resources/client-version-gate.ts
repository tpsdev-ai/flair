/**
 * client-version-gate.ts — flair#1383
 *
 * Pre-0.18.0 `@tpsdev-ai/flair-client` (and the adapters that shipped it)
 * runs a cosine-only write preflight and, on a hit, returns the existing
 * record WITHOUT issuing the PUT. The match can be another agent's
 * `shared` memory. The server never sees that write, so its cosine-AND-
 * Jaccard gate and `written: true` contract cannot run.
 *
 * A server upgrade does not fix a silent client. This module is the
 * server-side half: when a request *identifies* as a pre-0.18.0 client
 * on a Memory write path, refuse it loudly (426) and name the remedy
 * (upgrade the adapter, not the server).
 *
 * Honest limit: v0.17.0 does not send a library version (nor does any
 * published client before this change). Missing version is therefore
 * NOT treated as old — current published clients, raw HTTP, and
 * in-process `/mcp` would all false-positive. Identification is:
 *   - `X-Flair-Client: flair-client/<semver>` (or `flair-mcp/<semver>`)
 *   - optional write-body `flairClientVersion` (stripped, never stored)
 *
 * Harper-free so the compare/parse/denial shape is unit-testable
 * without a live table.
 */

export const MIN_SAFE_FLAIR_CLIENT = "0.18.0";
export const FLAIR_CLIENT_VERSION_HEADER = "x-flair-client";
export const FLAIR_CLIENT_VERSION_BODY = "flairClientVersion";

export const STALE_CLIENT_ERROR = "stale_flair_client";

const STALE_CLIENT_REMEDY =
  "Upgrade the adapter, not the server: `flair upgrade`, or pin " +
  `@tpsdev-ai/flair-mcp / @tpsdev-ai/flair-client >= ${MIN_SAFE_FLAIR_CLIENT}.`;

export function parseSemverCore(v: string): [number, number, number] | null {
  if (!v) return null;
  const core = v.trim().replace(/^v/, "").split("-")[0].split("+")[0];
  const parts = core.split(".");
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

export function semverLessThan(a: string, b: string): boolean {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

/** True when `version` is parseable and strictly older than 0.18.0. */
export function isUnsafeClientVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  return semverLessThan(version, MIN_SAFE_FLAIR_CLIENT);
}

/**
 * Parse `flair-client/0.17.0`, `flair-mcp/0.17.0`, or a bare `0.17.0`.
 * Unknown package prefixes still yield the version so a future adapter
 * name does not silently evade the gate.
 */
export function parseClientVersionToken(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (!token) return null;
  const slash = token.lastIndexOf("/");
  const version = slash === -1 ? token : token.slice(slash + 1);
  return parseSemverCore(version) ? version : null;
}

function headerGet(request: any, name: string): string | null {
  const headers = request?.headers;
  if (!headers) return null;
  const lower = name.toLowerCase();
  const fromGet = headers.get?.(lower) ?? headers.get?.(name);
  if (typeof fromGet === "string" && fromGet) return fromGet;
  const obj = headers.asObject ?? headers;
  const fromObj = obj?.[lower] ?? obj?.[name];
  return typeof fromObj === "string" && fromObj ? fromObj : null;
}

/**
 * Library version the caller declared, or null when absent/unparseable.
 * Header wins over the write-body passthrough. Never invents a version.
 */
export function readDeclaredClientVersion(request: any, content?: any): string | null {
  const fromHeader = parseClientVersionToken(headerGet(request, FLAIR_CLIENT_VERSION_HEADER));
  if (fromHeader) return fromHeader;
  return parseClientVersionToken(content?.[FLAIR_CLIENT_VERSION_BODY]);
}

/** Strip the write-body-only passthrough so it is never persisted. */
export function stripClientVersionPassthrough(content: any): void {
  if (content && typeof content === "object") delete content[FLAIR_CLIENT_VERSION_BODY];
}

export function staleClientDenialMessage(version: string): string {
  return (
    `This flair-client (${version}) silently drops writes — including against ` +
    `another agent's shared memories. ${STALE_CLIENT_REMEDY}`
  );
}

export function staleClientDenialBody(version: string): {
  error: string;
  message: string;
  clientVersion: string;
  minimumClientVersion: string;
} {
  return {
    error: STALE_CLIENT_ERROR,
    message: staleClientDenialMessage(version),
    clientVersion: version,
    minimumClientVersion: MIN_SAFE_FLAIR_CLIENT,
  };
}

export function staleClientWriteDenial(version: string): Response {
  return new Response(JSON.stringify(staleClientDenialBody(version)), {
    status: 426,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Refuse an identified pre-0.18.0 client on a Memory write path.
 * Missing version → null (serve). Internal/no-request → null (serve).
 */
export function refuseStaleClientWrite(request: any, content?: any): Response | null {
  const version = readDeclaredClientVersion(request, content);
  if (!isUnsafeClientVersion(version)) return null;
  return staleClientWriteDenial(version!);
}

/**
 * The v0.17.0 write() preflight shape: `POST /SemanticSearch` with
 * `limit: 1` and `scoring: "raw"`. Current write() never searches.
 * Exposed for fixtures and for a future search-path flag; not a refuse
 * trigger on its own (unversioned limit:1 raw searches are legitimate).
 */
export function isOldClientWritePreflight(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  const limit = data.limit;
  const scoring = data.scoring;
  return limit === 1 && (scoring === "raw" || scoring === undefined);
}
