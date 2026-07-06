/**
 * version-check.test.ts — Unit tests for the flair#587 version-behind check
 * used by `flair status` and `flair doctor`.
 *
 * Covers: severity classification (gap-based, no advisory data), the cache
 * (TTL respected / stale re-fetch / corrupt-cache tolerance), and the
 * offline-tolerance contract (fetch failure never throws, falls back to
 * cache or gives up quietly). The registry fetch and the cache file are both
 * fully mocked — no real network, no real $HOME writes.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkVersion,
  classifyGap,
  formatVersionNudge,
  defaultVersionCheckDeps,
  FLAIR_PKG_NAME,
  type VersionCheckDeps,
} from "../../src/version-check.js";

// ─── classifyGap / formatVersionNudge — pure severity heuristic ────────────

describe("classifyGap", () => {
  test("current (equal versions) → severity none", () => {
    expect(classifyGap("0.20.1", "0.20.1").severity).toBe("none");
  });

  test("ahead of latest (local/dev build) → severity none", () => {
    expect(classifyGap("0.21.0", "0.20.1").severity).toBe("none");
    expect(classifyGap("1.0.0", "0.20.1").severity).toBe("none");
  });

  test("one minor version behind → yellow", () => {
    const gap = classifyGap("0.19.0", "0.20.1");
    expect(gap.severity).toBe("yellow");
    expect(gap.majorBehind).toBe(false);
    expect(gap.releasesBehind).toBe(1);
  });

  test("two or more minor versions behind → red", () => {
    // The motivating flair#587 case: 0.16.1 → 0.20.1 (4 minor releases,
    // spanning two P0 security fixes).
    const gap = classifyGap("0.16.1", "0.20.1");
    expect(gap.severity).toBe("red");
    expect(gap.majorBehind).toBe(false);
    expect(gap.releasesBehind).toBe(4);
  });

  test("exactly two minor versions behind is the red threshold", () => {
    expect(classifyGap("0.18.0", "0.20.0").severity).toBe("red");
  });

  test("any major version behind → red, regardless of minor", () => {
    const gap = classifyGap("0.20.1", "1.0.0");
    expect(gap.severity).toBe("red");
    expect(gap.majorBehind).toBe(true);
  });

  test("patch-only gap → yellow, not red", () => {
    const gap = classifyGap("0.20.0", "0.20.5");
    expect(gap.severity).toBe("yellow");
    expect(gap.majorBehind).toBe(false);
    expect(gap.releasesBehind).toBe(5);
  });

  test("unparseable versions → severity none (never throws)", () => {
    expect(classifyGap("not-a-version", "0.20.1").severity).toBe("none");
    expect(classifyGap("0.20.1", "").severity).toBe("none");
  });
});

describe("formatVersionNudge", () => {
  test("returns null when current", () => {
    expect(formatVersionNudge({ installed: "0.20.1", latest: "0.20.1", source: "network" })).toBeNull();
  });

  test("returns null when latest is unknown (offline, no cache)", () => {
    expect(formatVersionNudge({ installed: "0.16.1", latest: null, source: "unavailable" })).toBeNull();
  });

  test("red nudge names the installed/latest versions, the release count, and the upgrade command", () => {
    const nudge = formatVersionNudge({ installed: "0.16.1", latest: "0.20.1", source: "network" });
    expect(nudge).not.toBeNull();
    expect(nudge!.severity).toBe("red");
    expect(nudge!.message).toContain("0.16.1");
    expect(nudge!.message).toContain("0.20.1");
    expect(nudge!.message).toContain("4 releases");
    expect(nudge!.message).toContain(`npm i -g ${FLAIR_PKG_NAME}@latest`);
  });

  test("yellow nudge for a single minor version behind", () => {
    const nudge = formatVersionNudge({ installed: "0.19.0", latest: "0.20.0", source: "cache" });
    expect(nudge!.severity).toBe("yellow");
    expect(nudge!.message).toContain("1 release");
  });

  test("major-behind nudge says 'major version', not a release count", () => {
    const nudge = formatVersionNudge({ installed: "0.20.1", latest: "1.0.0", source: "network" });
    expect(nudge!.severity).toBe("red");
    expect(nudge!.message).toContain("major version");
  });
});

// ─── checkVersion — cache + offline-tolerance contract ──────────────────────

describe("checkVersion", () => {
  let dir: string;
  const cachePathFor = (d: string) => join(d, ".version-check-cache.json");

  function baseDeps(overrides: Partial<VersionCheckDeps> = {}): Partial<VersionCheckDeps> {
    return {
      cachePath: cachePathFor(dir),
      ttlMs: 12 * 60 * 60 * 1000,
      timeoutMs: 100,
      ...overrides,
    };
  }

  // beforeEach/afterEach aren't imported — each test creates/cleans its own
  // tmpdir to avoid any cross-test cache bleed (cachePath is per-test anyway,
  // but this keeps disk tidy).
  function withTmpDir<T>(fn: () => T): T {
    dir = mkdtempSync(join(tmpdir(), "flair-version-check-"));
    try {
      return fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("network success writes the cache and reports source 'network'", async () => withTmpDir(async () => {
    let fetchCalls = 0;
    const cacheStore = new Map<string, { latest: string; checkedAt: number }>();
    const result = await checkVersion("0.16.1", baseDeps({
      fetchLatest: async () => { fetchCalls++; return "0.20.1"; },
      readCache: (p) => cacheStore.get(p) ?? null,
      writeCache: (p, entry) => { cacheStore.set(p, entry); },
      now: () => 1000,
    }));
    expect(result).toEqual({ installed: "0.16.1", latest: "0.20.1", source: "network" });
    expect(fetchCalls).toBe(1);
    expect(cacheStore.get(cachePathFor(dir))).toEqual({ latest: "0.20.1", checkedAt: 1000 });
  }));

  test("a fresh cache within TTL is used without calling fetch", async () => withTmpDir(async () => {
    let fetchCalls = 0;
    const cached = { latest: "0.20.1", checkedAt: 1000 };
    const result = await checkVersion("0.16.1", baseDeps({
      fetchLatest: async () => { fetchCalls++; return "0.99.0"; },
      readCache: () => cached,
      writeCache: () => { throw new Error("should not write when cache is fresh"); },
      now: () => 1000 + 60_000, // 1 minute later — well within a 12h TTL
      ttlMs: 12 * 60 * 60 * 1000,
    }));
    expect(fetchCalls).toBe(0);
    expect(result).toEqual({ installed: "0.16.1", latest: "0.20.1", source: "cache" });
  }));

  test("a stale cache (past TTL) triggers a re-fetch", async () => withTmpDir(async () => {
    let fetchCalls = 0;
    const cached = { latest: "0.20.1", checkedAt: 0 };
    const result = await checkVersion("0.16.1", baseDeps({
      fetchLatest: async () => { fetchCalls++; return "0.21.0"; },
      readCache: () => cached,
      writeCache: () => {},
      now: () => 13 * 60 * 60 * 1000, // 13h later — past the 12h TTL
      ttlMs: 12 * 60 * 60 * 1000,
    }));
    expect(fetchCalls).toBe(1);
    expect(result.latest).toBe("0.21.0");
    expect(result.source).toBe("network");
  }));

  test("fetch failure with no cache falls back to 'unavailable' — never throws", async () => withTmpDir(async () => {
    const result = await checkVersion("0.16.1", baseDeps({
      fetchLatest: async () => null, // simulates offline / timeout / non-2xx
      readCache: () => null,
      writeCache: () => {},
      now: () => Date.now(),
    }));
    expect(result).toEqual({ installed: "0.16.1", latest: null, source: "unavailable" });
  }));

  test("fetch failure with a stale cache falls back to the stale cache instead of giving up", async () => withTmpDir(async () => {
    const cached = { latest: "0.19.5", checkedAt: 0 };
    const result = await checkVersion("0.16.1", baseDeps({
      fetchLatest: async () => null,
      readCache: () => cached,
      writeCache: () => { throw new Error("should not write on fetch failure"); },
      now: () => 13 * 60 * 60 * 1000, // past TTL, so it attempts a fetch first
      ttlMs: 12 * 60 * 60 * 1000,
    }));
    expect(result).toEqual({ installed: "0.16.1", latest: "0.19.5", source: "cache" });
  }));

  test("never throws even if an injected fetchLatest itself throws (defense in depth)", async () => withTmpDir(async () => {
    const result = await checkVersion("0.16.1", baseDeps({
      fetchLatest: async () => { throw new Error("boom"); },
      readCache: () => null,
      writeCache: () => {},
      now: () => Date.now(),
    }));
    expect(result).toEqual({ installed: "0.16.1", latest: null, source: "unavailable" });
  }));

  // ── Real cache FILE (not an in-memory map) — only fetchLatest is mocked,
  // readCache/writeCache are the real fs-backed defaults, pointed at a tmp
  // file. Exercises the actual JSON round-trip + corrupt-file tolerance.

  test("real cache file: a network hit writes JSON that a subsequent real read TTL-hits", async () => withTmpDir(async () => {
    const cachePath = cachePathFor(dir);
    const { readCache, writeCache } = defaultVersionCheckDeps();
    let fetchCalls = 0;

    const first = await checkVersion("0.16.1", {
      cachePath, readCache, writeCache,
      fetchLatest: async () => { fetchCalls++; return "0.20.1"; },
      now: () => 1000,
      ttlMs: 12 * 60 * 60 * 1000,
    });
    expect(first).toEqual({ installed: "0.16.1", latest: "0.20.1", source: "network" });
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ latest: "0.20.1", checkedAt: 1000 });

    // Second call, shortly after, real file read — must NOT re-fetch.
    const second = await checkVersion("0.16.1", {
      cachePath, readCache, writeCache,
      fetchLatest: async () => { fetchCalls++; return "0.99.0"; },
      now: () => 1000 + 60_000,
      ttlMs: 12 * 60 * 60 * 1000,
    });
    expect(second).toEqual({ installed: "0.16.1", latest: "0.20.1", source: "cache" });
    expect(fetchCalls).toBe(1);
  }));

  test("real cache file: corrupt/garbage JSON is treated as no cache — re-fetches instead of throwing", async () => withTmpDir(async () => {
    const cachePath = cachePathFor(dir);
    writeFileSync(cachePath, "{ not valid json", "utf-8");
    const { readCache, writeCache } = defaultVersionCheckDeps();

    const result = await checkVersion("0.16.1", {
      cachePath, readCache, writeCache,
      fetchLatest: async () => "0.20.1",
      now: () => Date.now(),
      ttlMs: 12 * 60 * 60 * 1000,
    });
    expect(result).toEqual({ installed: "0.16.1", latest: "0.20.1", source: "network" });
  }));

  test("real cache file: missing cache dir is created on write (fresh ~/.flair install)", async () => withTmpDir(async () => {
    const cachePath = join(dir, "nested", "does-not-exist-yet", ".version-check-cache.json");
    const { readCache, writeCache } = defaultVersionCheckDeps();

    const result = await checkVersion("0.16.1", {
      cachePath, readCache, writeCache,
      fetchLatest: async () => "0.20.1",
      now: () => Date.now(),
      ttlMs: 12 * 60 * 60 * 1000,
    });
    expect(result.source).toBe("network");
    expect(existsSync(cachePath)).toBe(true);
  }));
});
