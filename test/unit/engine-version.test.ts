// test/unit/engine-version.test.ts — unit tests for engine version tracking (flair#1047)

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ENGINE_VERSION_STAMP,
  readInstalledHarperVersion,
  writeEngineVersionStamp,
  readEngineVersionStamp,
  checkEngineVersionBackwards,
  buildRecoveryLines,
} from "../../src/engine-version.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = join(tmpdir(), `flair-engine-version-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });
});
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function makeHarperPkg(dir: string, version: string): void {
  const nodeModules = join(dir, "node_modules", "harper");
  mkdirSync(nodeModules, { recursive: true });
  writeFileSync(join(nodeModules, "package.json"), JSON.stringify({ name: "harper", version }), "utf-8");
}

// ─── readInstalledHarperVersion ─────────────────────────────────────────────

describe("readInstalledHarperVersion", () => {
  it("reads the version from node_modules/harper/package.json", () => {
    makeHarperPkg(tmpRoot, "5.1.22");
    expect(readInstalledHarperVersion(tmpRoot)).toBe("5.1.22");
  });

  it("reads from @harperfast/harper when harper is absent", () => {
    const nodeModules = join(tmpRoot, "node_modules", "@harperfast", "harper");
    mkdirSync(nodeModules, { recursive: true });
    writeFileSync(join(nodeModules, "package.json"), JSON.stringify({ name: "@harperfast/harper", version: "5.2.0" }), "utf-8");
    expect(readInstalledHarperVersion(tmpRoot)).toBe("5.2.0");
  });

  it("prefers harper over @harperfast/harper when both exist", () => {
    makeHarperPkg(tmpRoot, "5.1.22");
    const alt = join(tmpRoot, "node_modules", "@harperfast", "harper");
    mkdirSync(alt, { recursive: true });
    writeFileSync(join(alt, "package.json"), JSON.stringify({ name: "@harperfast/harper", version: "5.2.0" }), "utf-8");
    expect(readInstalledHarperVersion(tmpRoot)).toBe("5.1.22");
  });

  it("returns null when no harper package is installed", () => {
    expect(readInstalledHarperVersion(tmpRoot)).toBeNull();
  });

  it("returns null when the package.json is unparseable", () => {
    const nodeModules = join(tmpRoot, "node_modules", "harper");
    mkdirSync(nodeModules, { recursive: true });
    writeFileSync(join(nodeModules, "package.json"), "not json", "utf-8");
    expect(readInstalledHarperVersion(tmpRoot)).toBeNull();
  });

  it("returns null when the package.json has no version field", () => {
    const nodeModules = join(tmpRoot, "node_modules", "harper");
    mkdirSync(nodeModules, { recursive: true });
    writeFileSync(join(nodeModules, "package.json"), JSON.stringify({ name: "harper" }), "utf-8");
    expect(readInstalledHarperVersion(tmpRoot)).toBeNull();
  });
});

// ─── writeEngineVersionStamp / readEngineVersionStamp ───────────────────────

describe("engine version stamp", () => {
  it("writes and reads the stamp", () => {
    writeEngineVersionStamp(tmpRoot, "5.1.22");
    expect(readEngineVersionStamp(tmpRoot)).toBe("5.1.22");
  });

  it("returns null when no stamp exists", () => {
    expect(readEngineVersionStamp(tmpRoot)).toBeNull();
  });

  it("returns null when the stamp file is empty", () => {
    writeFileSync(join(tmpRoot, ENGINE_VERSION_STAMP), "", "utf-8");
    expect(readEngineVersionStamp(tmpRoot)).toBeNull();
  });

  it("returns null when the stamp file is whitespace-only", () => {
    writeFileSync(join(tmpRoot, ENGINE_VERSION_STAMP), "  \n  ", "utf-8");
    expect(readEngineVersionStamp(tmpRoot)).toBeNull();
  });

  it("writes the stamp file in the data directory", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0");
    const stampPath = join(tmpRoot, ENGINE_VERSION_STAMP);
    expect(existsSync(stampPath)).toBe(true);
    expect(readFileSync(stampPath, "utf-8").trim()).toBe("5.2.0");
  });
});

// ─── checkEngineVersionBackwards ────────────────────────────────────────────

describe("checkEngineVersionBackwards", () => {
  it("returns null when no stamp exists (pre-stamp install)", () => {
    expect(checkEngineVersionBackwards(tmpRoot, "5.1.22")).toBeNull();
  });

  it("returns null when the running version equals the stamp", () => {
    writeEngineVersionStamp(tmpRoot, "5.1.22");
    expect(checkEngineVersionBackwards(tmpRoot, "5.1.22")).toBeNull();
  });

  it("returns null when the running version is newer than the stamp", () => {
    writeEngineVersionStamp(tmpRoot, "5.1.22");
    expect(checkEngineVersionBackwards(tmpRoot, "5.2.0")).toBeNull();
  });

  it("returns an error when the running version is older than the stamp", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0");
    const err = checkEngineVersionBackwards(tmpRoot, "5.1.22");
    expect(err).not.toBeNull();
    expect(err!).toContain("5.2.0"); // stamp version
    expect(err!).toContain("5.1.22"); // running version
    expect(err!).toContain(tmpRoot); // data directory path
    // Must contain a remedy
    expect(err!).toMatch(/reinstall|restore|snapshot/i);
  });

  it("handles multi-digit version components correctly", () => {
    writeEngineVersionStamp(tmpRoot, "5.10.0");
    // 5.9.0 < 5.10.0 — numeric compare, not string compare
    const err = checkEngineVersionBackwards(tmpRoot, "5.9.0");
    expect(err).not.toBeNull();
    expect(err!).toContain("5.10.0");
    expect(err!).toContain("5.9.0");
  });

  it("handles different-length version strings (stamp has more components)", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0.1");
    const err = checkEngineVersionBackwards(tmpRoot, "5.2.0");
    expect(err).not.toBeNull();
  });

  it("handles different-length version strings (running has more components)", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0");
    expect(checkEngineVersionBackwards(tmpRoot, "5.2.0.1")).toBeNull();
  });

  it("returns null when the stamp file is unreadable", () => {
    // Create a directory where the stamp file should be — can't read a dir as a file
    mkdirSync(join(tmpRoot, ENGINE_VERSION_STAMP), { recursive: true });
    expect(checkEngineVersionBackwards(tmpRoot, "5.1.22")).toBeNull();
  });

  // ── flair#1047: pre-release version ordering ──────────────────────────
  // Pre-releases must be ordered correctly, not blanket-refused.
  // A version WITH a pre-release is LOWER than the same core without one.
  // Harper published 5.2.0-beta.4 on 2026-07-31 and 5.2.0 on 2026-08-01 —
  // anyone who ran the beta must be able to start the release.

  it("allows beta → release: stamp 5.2.0-beta.4, running 5.2.0", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0-beta.4");
    expect(checkEngineVersionBackwards(tmpRoot, "5.2.0")).toBeNull();
  });

  it("allows rc → release: stamp 5.2.0-rc1, running 5.2.0", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0-rc1");
    expect(checkEngineVersionBackwards(tmpRoot, "5.2.0")).toBeNull();
  });

  it("allows earlier pre-release → later pre-release: stamp 5.2.0-beta.4, running 5.2.0-rc1", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0-beta.4");
    expect(checkEngineVersionBackwards(tmpRoot, "5.2.0-rc1")).toBeNull();
  });

  it("refuses release → pre-release: stamp 5.2.0, running 5.2.0-rc1", () => {
    // Same core, but stamp has no pre-release → stamp is newer.
    writeEngineVersionStamp(tmpRoot, "5.2.0");
    const err = checkEngineVersionBackwards(tmpRoot, "5.2.0-rc1");
    expect(err).not.toBeNull();
    expect(err!).toContain("5.2.0");
    expect(err!).toContain("5.2.0-rc1");
  });

  it("refuses when the stamp core is newer regardless of pre-release (stamp 5.2.1, running 5.2.0-rc1)", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.1");
    const err = checkEngineVersionBackwards(tmpRoot, "5.2.0-rc1");
    expect(err).not.toBeNull();
    expect(err!).toContain("5.2.1");
    expect(err!).toContain("5.2.0-rc1");
  });

  it("refuses when the stamp has a pre-release but the core is newer (stamp 5.2.0-beta.4, running 5.1.22)", () => {
    writeEngineVersionStamp(tmpRoot, "5.2.0-beta.4");
    const err = checkEngineVersionBackwards(tmpRoot, "5.1.22");
    expect(err).not.toBeNull();
    expect(err!).toContain("5.2.0-beta.4");
    expect(err!).toContain("5.1.22");
  });

  // ── Genuinely unparseable input ────────────────────────────────────────

  it("refuses with its own message when the stamp is not N.N.N (does not claim ordering)", () => {
    writeEngineVersionStamp(tmpRoot, "not-a-version");
    const err = checkEngineVersionBackwards(tmpRoot, "5.1.22");
    expect(err).not.toBeNull();
    // Must NOT claim "newer engine version" — we didn't determine ordering.
    expect(err!).not.toContain("newer engine version");
    expect(err!).toContain("could not be compared");
  });

  it("refuses with its own message when the running version is not N.N.N", () => {
    writeEngineVersionStamp(tmpRoot, "5.1.22");
    const err = checkEngineVersionBackwards(tmpRoot, "garbage");
    expect(err).not.toBeNull();
    expect(err!).not.toContain("newer engine version");
    expect(err!).toContain("could not be compared");
  });
});

// ─── buildRecoveryLines (flair#1051) ──────────────────────────────────────────

describe("buildRecoveryLines", () => {
  let snapshotDir: string;
  beforeEach(() => {
    snapshotDir = join(tmpRoot, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
  });

  it("with one snapshot: names it in a runnable restore command", () => {
    const fname = "flair-data-20260801T220000Z.tar.gz";
    writeFileSync(join(snapshotDir, fname), "dummy", "utf-8");

    const lines = buildRecoveryLines(snapshotDir);
    const msg = lines.join("\n");

    expect(msg).toContain(`flair snapshot restore ${join(snapshotDir, fname)}`);
    expect(msg).not.toContain("<timestamp>");
  });

  it("with multiple snapshots: names the newest and mentions 'flair snapshot list'", () => {
    // Two snapshots — second has a later timestamp (alphabetically greater)
    writeFileSync(join(snapshotDir, "flair-data-20260801T100000Z.tar.gz"), "old", "utf-8");
    writeFileSync(join(snapshotDir, "flair-data-20260801T220000Z.tar.gz"), "new", "utf-8");

    const lines = buildRecoveryLines(snapshotDir);
    const msg = lines.join("\n");

    // Newest should appear
    expect(msg).toContain("flair-data-20260801T220000Z.tar.gz");
    // Oldest should NOT appear as the restore target
    expect(msg).not.toContain("flair-data-20260801T100000Z.tar.gz");
    // Should mention list command
    expect(msg).toContain("flair snapshot list");
  });

  it("with no snapshots: no 'snapshot restore' line anywhere", () => {
    const lines = buildRecoveryLines(snapshotDir);
    const msg = lines.join("\n");

    expect(msg).not.toContain("snapshot restore");
    expect(msg).toContain("No pre-upgrade snapshot was found");
  });
});


