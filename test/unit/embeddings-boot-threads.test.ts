import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveEmbedThreads, resolveEmbedGpuLayers } from "../../resources/embeddings-boot.ts";

/**
 * resolveEmbedThreads() (flair#1330) — the value embeddings-boot passes to
 * HFE `register({config:{threads}})`. HFE's own default is a fixed 6;
 * flair used to omit the field and inherit that on every host.
 *
 * Locks:
 *   1. The host-aware default is `max(1, cores - 1)`, not `min(6, cores)`
 *      and not HFE's 6. Injected `cores` so CI machine size cannot hide a
 *      formula change.
 *   2. The no-arg form actually calls `availableParallelism()` (cgroup-
 *      aware), not `os.cpus().length`.
 *   3. `FLAIR_EMBED_THREADS` is the override; invalid values fall through.
 *   4. embeddings-boot's `register()` call site actually passes
 *      `threads: resolveEmbedThreads()` — a source tripwire so the helper
 *      cannot drift off the plumbing.
 */
describe("resolveEmbedThreads (flair#1330 — host-aware HFE threads)", () => {
  const SAVED = process.env.FLAIR_EMBED_THREADS;

  beforeEach(() => {
    delete process.env.FLAIR_EMBED_THREADS;
  });

  afterEach(() => {
    if (SAVED === undefined) delete process.env.FLAIR_EMBED_THREADS;
    else process.env.FLAIR_EMBED_THREADS = SAVED;
  });

  describe("host-aware default (env unset)", () => {
    it("8 cores → 7 (the measured idle-core case: HFE's 6 left 2 cores unused)", () => {
      expect(resolveEmbedThreads({}, 8)).toBe(7);
    });

    it("4 cores → 3 (avoids HFE's 6-thread oversubscription on a small host)", () => {
      expect(resolveEmbedThreads({}, 4)).toBe(3);
    });

    it("6 cores → 5 (does not cling to HFE's fixed 6)", () => {
      expect(resolveEmbedThreads({}, 6)).toBe(5);
    });

    it("2 cores → 1 (leaves one core; never returns 0)", () => {
      expect(resolveEmbedThreads({}, 2)).toBe(1);
    });

    it("1 core → 1 (floor; cores - 1 would be 0)", () => {
      expect(resolveEmbedThreads({}, 1)).toBe(1);
    });

    it("non-finite / sub-1 cores still floor at 1", () => {
      expect(resolveEmbedThreads({}, 0)).toBe(1);
      expect(resolveEmbedThreads({}, -4)).toBe(1);
      expect(resolveEmbedThreads({}, Number.NaN)).toBe(1);
    });

    it("no-arg form uses availableParallelism() - 1 (cgroup-aware, not os.cpus().length)", () => {
      expect(resolveEmbedThreads()).toBe(Math.max(1, availableParallelism() - 1));
    });
  });

  describe("FLAIR_EMBED_THREADS override", () => {
    it("honors a positive integer", () => {
      expect(resolveEmbedThreads({ FLAIR_EMBED_THREADS: "8" }, 4)).toBe(8);
      expect(resolveEmbedThreads({ FLAIR_EMBED_THREADS: "1" }, 16)).toBe(1);
    });

    it("trims whitespace", () => {
      expect(resolveEmbedThreads({ FLAIR_EMBED_THREADS: "  4  " }, 16)).toBe(4);
    });

    it("reads process.env when the env arg is omitted", () => {
      process.env.FLAIR_EMBED_THREADS = "12";
      expect(resolveEmbedThreads()).toBe(12);
    });

    it("falls through to the host-aware default on empty / non-integer / <1", () => {
      for (const raw of ["", "   ", "abc", "0", "-1", "1.5", "8cpu", "NaN"]) {
        expect(resolveEmbedThreads({ FLAIR_EMBED_THREADS: raw }, 8)).toBe(7);
      }
    });
  });
});

describe("embeddings-boot register() plumbing (flair#1330)", () => {
  it("passes threads: resolveEmbedThreads() into HFE register() config", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "resources", "embeddings-boot.ts"),
      "utf8",
    );
    expect(src).toContain("const threads = resolveEmbedThreads();");
    expect(src).toMatch(/register\(\{[\s\S]*threads,/);
  });
});

describe("resolveEmbedGpuLayers (flair#1436 — measurement pin, default unchanged)", () => {
  const SAVED = process.env.FLAIR_EMBED_GPU_LAYERS;

  beforeEach(() => {
    delete process.env.FLAIR_EMBED_GPU_LAYERS;
  });

  afterEach(() => {
    if (SAVED === undefined) delete process.env.FLAIR_EMBED_GPU_LAYERS;
    else process.env.FLAIR_EMBED_GPU_LAYERS = SAVED;
  });

  it("unset → undefined (omit the field; HFE default 0 is unchanged)", () => {
    expect(resolveEmbedGpuLayers({})).toBeUndefined();
    expect(resolveEmbedGpuLayers()).toBeUndefined();
  });

  it("honors 0 and 99", () => {
    expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: "0" })).toBe(0);
    expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: "99" })).toBe(99);
  });

  it("invalid values fall through to omit (same as unset)", () => {
    for (const raw of ["", "   ", "abc", "-1", "1.5", "NaN", "99gpu"]) {
      expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: raw })).toBeUndefined();
    }
  });

  it("reads process.env when the env arg is omitted", () => {
    process.env.FLAIR_EMBED_GPU_LAYERS = "99";
    expect(resolveEmbedGpuLayers()).toBe(99);
  });
});

describe("embeddings-boot register() gpuLayers plumbing (flair#1436)", () => {
  it("omits gpuLayers unless resolveEmbedGpuLayers() returns a number — no synthesized default", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "resources", "embeddings-boot.ts"),
      "utf8",
    );
    expect(src).toContain("const gpuLayers = resolveEmbedGpuLayers();");
    expect(src).toContain("...(gpuLayers !== undefined ? { gpuLayers } : {})");
    // Must not hardcode a product default (that is #1437).
    expect(src).not.toMatch(/gpuLayers:\s*99/);
    expect(src).not.toMatch(/gpuLayers:\s*resolveEmbedGpuLayers\(\)\s*\?\?/);
  });
});
