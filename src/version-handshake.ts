/**
 * version-handshake.ts — CLI↔server version handshake (flair#695 §B, the
 * bare-npm rescue): "Every CLI invocation (cheap, cached ~60s) compares:
 * CLI version, installed-package version, running-server version. Mismatch
 * → one-line nudge on stderr: `flair 0.23.0 installed but server is running
 * 0.22.1 — run: flair restart`. Never blocks the command."
 *
 * Mirrors src/version-check.ts's discipline exactly (that module compares
 * installed-vs-latest-PUBLISHED; this one compares installed-vs-RUNNING):
 * offline-tolerant, short fetch timeout, cached with a TTL, NEVER throws.
 * The one behavioral difference from version-check.ts: the cache is keyed
 * per (rootPath, serverUrl) rather than one global file — a single CLI can
 * legitimately point at more than one local Flair instance (different
 * ROOTPATH, or a --target-switched remote), and a mismatch cached for one
 * must never bleed into a nudge about a different one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_HANDSHAKE_TTL_MS = 60_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1500; // within the spec's 1-2s budget
export const DEFAULT_HANDSHAKE_CACHE_DIR = join(homedir(), ".flair", ".version-handshake-cache");

interface CacheEntry {
  runningVersion: string | null;
  checkedAt: number; // epoch ms
}

export interface HandshakeDeps {
  fetchImpl: typeof fetch;
  cacheDir: string;
  ttlMs: number;
  timeoutMs: number;
  now: () => number;
}

export function defaultHandshakeDeps(): HandshakeDeps {
  return {
    fetchImpl: fetch,
    cacheDir: DEFAULT_HANDSHAKE_CACHE_DIR,
    ttlMs: DEFAULT_HANDSHAKE_TTL_MS,
    timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
    now: () => Date.now(),
  };
}

function cacheFileName(rootPath: string, serverUrl: string): string {
  return createHash("sha256").update(`${rootPath}|${serverUrl}`).digest("hex").slice(0, 32) + ".json";
}

function cacheFilePath(cacheDir: string, rootPath: string, serverUrl: string): string {
  return join(cacheDir, cacheFileName(rootPath, serverUrl));
}

function readCache(path: string): CacheEntry | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw?.checkedAt === "number" && (typeof raw?.runningVersion === "string" || raw?.runningVersion === null)) {
      return { runningVersion: raw.runningVersion, checkedAt: raw.checkedAt };
    }
    return null;
  } catch {
    return null; // corrupt/unreadable cache — treat as absent, never throw
  }
}

function writeCache(path: string, entry: CacheEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry));
  } catch {
    // Best-effort — a cache-write failure (e.g. read-only $HOME) must never
    // surface as a command error.
  }
}

export type HandshakeSource = "cache" | "network" | "unavailable";

export interface HandshakeResult {
  cliVersion: string;
  /** null when the server was unreachable and there's no usable cache either. */
  runningVersion: string | null;
  mismatch: boolean;
  source: HandshakeSource;
}

/**
 * Resolves the running server's version (via the public, unauthenticated
 * `GET /Health` — reachable even before an agent key exists) and compares
 * it to `cliVersion`. NEVER throws — every failure mode (offline, timeout,
 * non-2xx, malformed JSON, cache I/O error) resolves to `source:
 * "unavailable"` with `mismatch: false`, never an exception or a false
 * nudge.
 */
export async function checkServerHandshake(
  cliVersion: string,
  rootPath: string,
  serverUrl: string,
  injected: Partial<HandshakeDeps> = {},
): Promise<HandshakeResult> {
  const deps: HandshakeDeps = { ...defaultHandshakeDeps(), ...injected };
  const path = cacheFilePath(deps.cacheDir, rootPath, serverUrl);
  const nowMs = deps.now();

  const cached = readCache(path);
  if (cached && nowMs - cached.checkedAt < deps.ttlMs) {
    return {
      cliVersion,
      runningVersion: cached.runningVersion,
      mismatch: !!cached.runningVersion && cached.runningVersion !== cliVersion,
      source: "cache",
    };
  }

  let fetched: string | null = null;
  try {
    const res = await deps.fetchImpl(`${serverUrl.replace(/\/+$/, "")}/Health`, {
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown };
      fetched = typeof body?.version === "string" ? body.version : null;
    }
  } catch {
    fetched = null; // offline, DNS failure, timeout, non-JSON body — all the same: couldn't determine it this time
  }

  if (fetched !== null) {
    writeCache(path, { runningVersion: fetched, checkedAt: nowMs });
    return { cliVersion, runningVersion: fetched, mismatch: fetched !== cliVersion, source: "network" };
  }

  if (cached) {
    // Server unreachable this time — fall back to a stale cache rather than
    // reporting nothing.
    return {
      cliVersion,
      runningVersion: cached.runningVersion,
      mismatch: !!cached.runningVersion && cached.runningVersion !== cliVersion,
      source: "cache",
    };
  }
  return { cliVersion, runningVersion: null, mismatch: false, source: "unavailable" };
}

/**
 * The one-line stderr nudge, or null when there's nothing worth printing
 * (no mismatch, or nothing to compare against). Exact wording per the spec:
 * "flair 0.23.0 installed but server is running 0.22.1 — run: flair restart".
 */
export function formatHandshakeNudge(result: HandshakeResult): string | null {
  if (!result.mismatch || !result.runningVersion) return null;
  return `flair ${result.cliVersion} installed but server is running ${result.runningVersion} — run: flair restart`;
}
