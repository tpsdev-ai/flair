/**
 * scheduler-flair-bin.test.ts — flair#1279: FLAIR_BIN is captured at enable
 * time and trusted forever. These tests pin the smallest honest fix: resolve
 * a relative capture to an absolute path, and warn (do not substitute, do
 * not refuse) when the baked path is not the public `flair` entry.
 *
 * The shim is NOT rewritten here — #1231's `exec <node> <script>` form and
 * zero run-time PATH lookups stay intact. This file tests the shared
 * resolver in src/lib/scheduler-platform.ts; the two enableScheduler
 * callers are covered in their own suites.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveFlairBin,
  isCanonicalFlairBin,
  formatFlairBinWarning,
} from "../../src/lib/scheduler-platform.ts";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-flair-bin-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("isCanonicalFlairBin", () => {
  it("a file named `flair` is the public entry — even if PATH has nothing", () => {
    expect(isCanonicalFlairBin("/usr/local/bin/flair", null)).toBe(true);
    expect(isCanonicalFlairBin("/opt/flair/current/bin/flair", null)).toBe(true);
  });

  it("a working-tree dist/cli.js is not canonical", () => {
    expect(isCanonicalFlairBin("/home/me/code/flair/dist/cli.js", null)).toBe(false);
  });

  it("a versioned blue/green tree is not canonical", () => {
    expect(isCanonicalFlairBin("/opt/flair/v0.49.0/dist/cli.js", null)).toBe(false);
  });

  it("the same file as `command -v flair` is canonical even when the baked path is the realpath", () => {
    const real = join(testRoot, "cli-shim.cjs");
    const pub = join(testRoot, "bin", "flair");
    writeFileSync(real, "/* shim */\n");
    mkdirSync(join(testRoot, "bin"), { recursive: true });
    symlinkSync(real, pub);
    expect(isCanonicalFlairBin(real, pub)).toBe(true);
  });
});

describe("resolveFlairBin", () => {
  it("an explicit override wins, relatives become absolute, and a named `flair` is canonical", () => {
    const r = resolveFlairBin("/usr/local/bin/flair", { publicBin: null });
    expect(r.path).toBe("/usr/local/bin/flair");
    expect(r.canonical).toBe(true);
    expect(r.publicBin).toBeNull();
  });

  it("a relative working-tree capture is resolved against cwd and is not canonical", () => {
    const r = resolveFlairBin(undefined, { argv1: "dist/cli.js", publicBin: null });
    expect(r.path).toBe(resolve("dist/cli.js"));
    expect(r.path.startsWith("/")).toBe(true);
    expect(basename(r.path)).toBe("cli.js");
    expect(r.canonical).toBe(false);
  });

  it("does NOT silently substitute the public entry for a working-tree capture", () => {
    const captured = join(testRoot, "checkout", "dist", "cli.js");
    const r = resolveFlairBin(captured, { publicBin: "/usr/local/bin/flair" });
    // The enabling process is what gets baked — substituting `command -v flair`
    // would pick a stale global on a fleet host that just deployed a tree.
    expect(r.path).toBe(captured);
    expect(r.canonical).toBe(false);
    expect(r.publicBin).toBe("/usr/local/bin/flair");
  });

  it("falls back to the public entry only when argv[1] is empty", () => {
    const r = resolveFlairBin(undefined, { argv1: "", publicBin: "/usr/local/bin/flair" });
    expect(r.path).toBe("/usr/local/bin/flair");
    expect(r.canonical).toBe(true);
  });

  it("throws rather than bake a bare `flair` name when nothing is resolvable", () => {
    expect(() => resolveFlairBin(undefined, { argv1: "", publicBin: null })).toThrow(
      /absolute path to the flair CLI/,
    );
  });
});

describe("formatFlairBinWarning", () => {
  const ENABLE = "flair federation sync enable";

  it("is silent for a canonical path", () => {
    expect(formatFlairBinWarning("/usr/local/bin/flair", null, ENABLE)).toEqual([]);
  });

  it("names the baked path, the swap hazard, and the public entry when one exists", () => {
    const lines = formatFlairBinWarning(
      "/home/me/flair/dist/cli.js",
      "/usr/local/bin/flair",
      ENABLE,
    );
    const text = lines.join("\n");
    expect(text).toContain("⚠️  FLAIR_BIN is /home/me/flair/dist/cli.js");
    expect(text).toContain("not a stable public entry");
    expect(text).toContain("blue/green directory swap");
    expect(text).toContain("strand the scheduler unit");
    expect(text).toContain("Public `flair` on PATH: /usr/local/bin/flair");
    expect(text).toContain(ENABLE);
    expect(text).not.toContain("No `flair` on PATH");
  });

  it("names the no-PATH remedy when there is no public entry", () => {
    const lines = formatFlairBinWarning("/opt/flair/v0.49.0/dist/cli.js", null, "flair rem nightly enable");
    const text = lines.join("\n");
    expect(text).toContain("/opt/flair/v0.49.0/dist/cli.js");
    expect(text).toContain("No `flair` on PATH");
    expect(text).toContain("flair rem nightly enable");
    expect(text).toContain("stable symlink");
  });
});
