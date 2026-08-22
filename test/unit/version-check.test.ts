/**
 * version-check.test.ts — Unit tests for the flair#587 version-behind check
 * used by `flair status` and `flair doctor`.
 *
 * Covers: severity classification (gap-based, no advisory data), the cache
 * (TTL respected / stale re-fetch / corrupt-cache tolerance), the
 * offline-tolerance contract (fetch failure never throws, falls back to
 * cache or gives up quietly), and the flair#1341 honest-numbers contract
 * (cache-sourced nudges are age-qualified, a nudging cache refetches once,
 * count labels name their unit, suggestion is `flair upgrade`). The registry
 * fetch and the cache file are both fully mocked — no real network, no real
 * $HOME writes.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkVersion,
  classifyGap,
  formatVersionNudge,
  primeVersionCheckCache,
  defaultVersionCheckDeps,
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

  test("one minor version behind → yellow, counted in minors", () => {
    const gap = classifyGap("0.19.0", "0.20.1");
    expect(gap.severity).toBe("yellow");
    expect(gap.majorBehind).toBe(false);
    expect(gap.unit).toBe("minor");
    expect(gap.versionsBehind).toBe(1);
  });

  test("two or more minor versions behind → red", () => {
    // The motivating flair#587 case: 0.16.1 → 0.20.1 (4 minor versions,
    // spanning two P0 security fixes).
    const gap = classifyGap("0.16.1", "0.20.1");
    expect(gap.severity).toBe("red");
    expect(gap.majorBehind).toBe(false);
    expect(gap.unit).toBe("minor");
    expect(gap.versionsBehind).toBe(4);
  });

  test("exactly two minor versions behind is the red threshold", () => {
    expect(classifyGap("0.18.0", "0.20.0").severity).toBe("red");
  });

  test("any major version behind → red, regardless of minor", () => {
    const gap = classifyGap("0.20.1", "1.0.0");
    expect(gap.severity).toBe("red");
    expect(gap.majorBehind).toBe(true);
  });

  test("patch-only gap → yellow, not red, counted in patch releases", () => {
    const gap = classifyGap("0.20.0", "0.20.5");
    expect(gap.severity).toBe("yellow");
    expect(gap.majorBehind).toBe(false);
    expect(gap.unit).toBe("patch");
    expect(gap.versionsBehind).toBe(5);
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

  test("red nudge names the installed/latest versions, the minor-version count, and the upgrade command", () => {
    const nudge = formatVersionNudge({ installed: "0.16.1", latest: "0.20.1", source: "network" });
    expect(nudge).not.toBeNull();
    expect(nudge!.severity).toBe("red");
    expect(nudge!.message).toContain("0.16.1");
    expect(nudge!.message).toContain("latest is 0.20.1");
    // flair#1341: the label must say what was counted — a minor-version
    // delta must never be presented as "4 releases".
    expect(nudge!.message).toContain("4 minor versions behind");
    expect(nudge!.message).not.toContain("4 releases");
  });

  test("yellow nudge for a single minor version behind (singular label)", () => {
    const nudge = formatVersionNudge({ installed: "0.19.0", latest: "0.20.0", source: "network" });
    expect(nudge!.severity).toBe("yellow");
    expect(nudge!.message).toContain("1 minor version behind");
  });

  test("patch-only nudge counts patch releases — the one delta that IS a release count", () => {
    // Within a minor, patches publish sequentially (v0.44.0…v0.44.13 with no
    // gaps in the tag history), so patch delta = releases behind.
    const nudge = formatVersionNudge({ installed: "0.47.0", latest: "0.47.1", source: "network" });
    expect(nudge!.severity).toBe("yellow");
    expect(nudge!.message).toContain("1 patch release behind");
  });

  test("major-behind nudge says 'major version', not a release count", () => {
    const nudge = formatVersionNudge({ installed: "0.20.1", latest: "1.0.0", source: "network" });
    expect(nudge!.severity).toBe("red");
    expect(nudge!.message).toContain("major version");
  });

  // ── flair#1341 fix 1: cache-sourced answers must be qualified ─────────────

  test("cache-sourced nudge qualifies the fact with its age instead of stating it as current", () => {
    const nudge = formatVersionNudge({
      installed: "0.45.0",
      latest: "0.47.1",
      source: "cache",
      checkedAgoMs: 9 * 60 * 60 * 1000,
    });
    expect(nudge!.message).toContain("latest known (checked 9h ago): 0.47.1");
    expect(nudge!.message).not.toContain("latest is 0.47.1");
    expect(nudge!.message).toContain("2 minor versions behind");
  });

  test("cache-sourced nudge without a known age still says 'latest known', never 'latest is'", () => {
    const nudge = formatVersionNudge({ installed: "0.45.0", latest: "0.47.1", source: "cache" });
    expect(nudge!.message).toContain("latest known: 0.47.1");
    expect(nudge!.message).not.toContain("latest is");
  });

  test("cache age renders in minutes under an hour and days past 48h", () => {
    const at = (checkedAgoMs: number) =>
      formatVersionNudge({ installed: "0.45.0", latest: "0.47.1", source: "cache", checkedAgoMs })!.message;
    expect(at(25 * 60 * 1000)).toContain("checked 25m ago");
    expect(at(3 * 24 * 60 * 60 * 1000)).toContain("checked 3d ago");
  });

  // ── flair#1341 fix 3: suggest the paved path, not a bare npm install ──────

  test("every nudge suggests flair upgrade, never npm i -g", () => {
    const cases = [
      formatVersionNudge({ installed: "0.16.1", latest: "0.20.1", source: "network" }),
      formatVersionNudge({ installed: "0.19.0", latest: "0.20.0", source: "network" }),
      formatVersionNudge({ installed: "0.47.0", latest: "0.47.1", source: "network" }),
      formatVersionNudge({ installed: "0.20.1", latest: "1.0.0", source: "network" }),
      formatVersionNudge({ installed: "0.45.0", latest: "0.47.1", source: "cache", checkedAgoMs: 60_000 }),
    ];
    for (const nudge of cases) {
      expect(nudge!.message).toContain("Run: flair upgrade");
      expect(nudge!.message).not.toContain("npm i -g");
    }
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

  test("a fresh cache within TTL is used without calling fetch when it implies no nudge", async () => withTmpDir(async () => {
    // flair#1341: the TTL fast-path is reserved for the no-nudge common case
    // — up-to-date installs never pay a network round trip.
    let fetchCalls = 0;
    const cached = { latest: "0.20.1", checkedAt: 1000 };
    const result = await checkVersion("0.20.1", baseDeps({
      fetchLatest: async () => { fetchCalls++; return "0.99.0"; },
      readCache: () => cached,
      writeCache: () => { throw new Error("should not write when cache is fresh"); },
      now: () => 1000 + 60_000, // 1 minute later — well within a 12h TTL
      ttlMs: 12 * 60 * 60 * 1000,
    }));
    expect(fetchCalls).toBe(0);
    expect(result).toEqual({ installed: "0.20.1", latest: "0.20.1", source: "cache", checkedAgoMs: 60_000 });
  }));

  // ── flair#1341 fix 1: a cached answer that WOULD nudge refetches ──────────

  test("a fresh cache that would print a nudge triggers one refetch and the fresh answer wins", async () => withTmpDir(async () => {
    let fetchCalls = 0;
    const cacheStore = new Map<string, { latest: string; checkedAt: number }>();
    cacheStore.set(cachePathFor(dir), { latest: "0.47.1", checkedAt: 1000 });
    const result = await checkVersion("0.45.0", baseDeps({
      fetchLatest: async () => { fetchCalls++; return "0.48.0"; },
      readCache: (p) => cacheStore.get(p) ?? null,
      writeCache: (p, entry) => { cacheStore.set(p, entry); },
      now: () => 1000 + 60_000, // well within TTL — refetch happens ANYWAY because a nudge would print
      ttlMs: 12 * 60 * 60 * 1000,
    }));
    expect(fetchCalls).toBe(1);
    expect(result).toEqual({ installed: "0.45.0", latest: "0.48.0", source: "network" });
    expect(cacheStore.get(cachePathFor(dir))).toEqual({ latest: "0.48.0", checkedAt: 1000 + 60_000 });
  }));

  test("refetch failure falls back to the fresh-but-nudging cache, age attached (offline tolerance intact)", async () => withTmpDir(async () => {
    let fetchCalls = 0;
    const cached = { latest: "0.47.1", checkedAt: 1000 };
    const result = await checkVersion("0.45.0", baseDeps({
      fetchLatest: async () => { fetchCalls++; return null; }, // offline / timeout / 5xx
      readCache: () => cached,
      writeCache: () => { throw new Error("should not write on fetch failure"); },
      now: () => 1000 + 9 * 60 * 60 * 1000, // 9h later — within TTL
      ttlMs: 12 * 60 * 60 * 1000,
    }));
    expect(fetchCalls).toBe(1);
    expect(result).toEqual({
      installed: "0.45.0",
      latest: "0.47.1",
      source: "cache",
      checkedAgoMs: 9 * 60 * 60 * 1000,
    });
    // And the nudge built from that fallback is the qualified one.
    expect(formatVersionNudge(result)!.message).toContain("latest known (checked 9h ago): 0.47.1");
  }));

  test("a throwing refetch on the nudge path still falls back to the cache — never throws", async () => withTmpDir(async () => {
    const cached = { latest: "0.47.1", checkedAt: 1000 };
    const result = await checkVersion("0.45.0", baseDeps({
      fetchLatest: async () => { throw new Error("boom"); },
      readCache: () => cached,
      writeCache: () => {},
      now: () => 1000 + 60_000,
      ttlMs: 12 * 60 * 60 * 1000,
    }));
    expect(result.source).toBe("cache");
    expect(result.latest).toBe("0.47.1");
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
    expect(result).toEqual({
      installed: "0.16.1",
      latest: "0.19.5",
      source: "cache",
      checkedAgoMs: 13 * 60 * 60 * 1000,
    });
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

    const first = await checkVersion("0.20.1", {
      cachePath, readCache, writeCache,
      fetchLatest: async () => { fetchCalls++; return "0.20.1"; },
      now: () => 1000,
      ttlMs: 12 * 60 * 60 * 1000,
    });
    expect(first).toEqual({ installed: "0.20.1", latest: "0.20.1", source: "network" });
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ latest: "0.20.1", checkedAt: 1000 });

    // Second call, shortly after, real file read, up-to-date install (no
    // nudge implied) — must NOT re-fetch (flair#1341 keeps this fast path).
    const second = await checkVersion("0.20.1", {
      cachePath, readCache, writeCache,
      fetchLatest: async () => { fetchCalls++; return "0.99.0"; },
      now: () => 1000 + 60_000,
      ttlMs: 12 * 60 * 60 * 1000,
    });
    expect(second).toEqual({ installed: "0.20.1", latest: "0.20.1", source: "cache", checkedAgoMs: 60_000 });
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

// ─── primeVersionCheckCache — `flair upgrade` writing the freshly-fetched
// latest into the SAME cache `checkVersion` (status/doctor) reads from ─────

describe("primeVersionCheckCache", () => {
  let dir: string;
  const cachePathFor = (d: string) => join(d, ".version-check-cache.json");

  function withTmpDir<T>(fn: () => T): T {
    dir = mkdtempSync(join(tmpdir(), "flair-version-check-prime-"));
    try {
      return fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("writes the cache such that a subsequent checkVersion returns the primed latest without a network fetch", async () => withTmpDir(async () => {
    const cachePath = cachePathFor(dir);
    primeVersionCheckCache("0.25.2", { cachePath, now: () => 1000 });

    // Post-upgrade reality: the CLI now RUNS the version it just primed, so
    // the cached answer implies no nudge and the TTL fast-path applies
    // (flair#1341 only refetches when a nudge would print).
    let fetchCalls = 0;
    const { readCache, writeCache } = defaultVersionCheckDeps();
    const result = await checkVersion("0.25.2", {
      cachePath, readCache, writeCache,
      fetchLatest: async () => { fetchCalls++; return "0.99.0"; },
      now: () => 1000 + 60_000, // shortly after — well within the 12h TTL
      ttlMs: 12 * 60 * 60 * 1000,
    });

    expect(fetchCalls).toBe(0);
    expect(result).toEqual({ installed: "0.25.2", latest: "0.25.2", source: "cache", checkedAgoMs: 60_000 });
  }));

  test("writes real JSON at the module default cache-file shape (latest + checkedAt)", async () => withTmpDir(async () => {
    const cachePath = cachePathFor(dir);
    primeVersionCheckCache("0.25.2", { cachePath, now: () => 1234 });

    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ latest: "0.25.2", checkedAt: 1234 });
  }));
});
