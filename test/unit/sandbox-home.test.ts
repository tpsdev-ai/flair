// Sandbox HOME for every test process, and the real-config guard (flair#1853).
//
// The preload (bunfig.toml → test/helpers/sandbox-home.ts) runs before any test
// module, so by the time this file executes the process HOME is already a fresh
// temp dir. The guard tests never touch the real home: they build a stand-in
// home under the OS temp dir and plant changes there.

import { describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  CLAUDE_JSON_SUBTREE,
  REAL_CLIENT_CONFIGS,
  changedConfigs,
  runGuarded,
  snapshotClientConfigs,
} from "../../scripts/home-isolation-guard.ts";

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-guard-home-"));
  fixtures.push(dir);
  return dir;
}

function plant(home: string, rel: string, content: string): void {
  const full = join(home, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("sandbox HOME preload (flair#1853)", () => {
  it("points HOME, USERPROFILE and PI_CODING_AGENT_DIR at a temp dir, not the real home", () => {
    const home = process.env.HOME;
    expect(home).toBeTruthy();
    // Under the OS temp dir…
    expect(realpathSync(home!).startsWith(realpathSync(tmpdir()))).toBe(true);
    // …and specifically NOT the real user home.
    expect(home).not.toBe(userInfo().homedir);
    // The three vars agree, so an unswapped writer cannot escape to the real
    // home through any of them.
    expect(process.env.USERPROFILE).toBe(home);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(home);
  });
});

describe("real-config guard (flair#1853)", () => {
  it("reports no change when nothing was touched", () => {
    const home = fakeHome();
    for (const rel of REAL_CLIENT_CONFIGS) plant(home, rel, `initial: ${rel}\n`);
    plant(home, ".claude.json", JSON.stringify({ mcpServers: {}, projects: {} }));
    const before = snapshotClientConfigs(home);
    expect(changedConfigs(before, snapshotClientConfigs(home))).toEqual([]);
  });

  it("fires on a planted change to a stand-in copy", () => {
    const home = fakeHome();
    for (const rel of REAL_CLIENT_CONFIGS) plant(home, rel, `v1: ${rel}\n`);
    const before = snapshotClientConfigs(home);
    const target = REAL_CLIENT_CONFIGS[0]!;
    plant(home, target, "planted-change\n");
    expect(changedConfigs(before, snapshotClientConfigs(home))).toContain(target);
  });

  it("treats a newly appearing config as a change", () => {
    const home = fakeHome();
    const before = snapshotClientConfigs(home);
    const target = REAL_CLIENT_CONFIGS[2]!;
    plant(home, target, "appeared\n");
    expect(changedConfigs(before, snapshotClientConfigs(home))).toContain(target);
  });

  it("fingerprints ~/.claude.json on the mcpServers subtree only", () => {
    const home = fakeHome();
    plant(
      home,
      ".claude.json",
      JSON.stringify({ mcpServers: { flair: { command: "flair-mcp" } }, projects: { a: 1 } }),
    );
    const before = snapshotClientConfigs(home);
    // Churn OUTSIDE mcpServers is invisible (Claude Code rewrites it constantly).
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { flair: { command: "flair-mcp" } }, projects: { a: 2 }, x: true }),
    );
    expect(changedConfigs(before, snapshotClientConfigs(home))).toEqual([]);
    // A change INSIDE mcpServers is reported.
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { flair: { command: "flair-mcp@next" } }, projects: { a: 2 } }),
    );
    expect(changedConfigs(before, snapshotClientConfigs(home))).toContain(CLAUDE_JSON_SUBTREE);
  });

  it("runGuarded returns the path a body changed", () => {
    const home = fakeHome();
    const target = REAL_CLIENT_CONFIGS[1]!;
    plant(home, target, "before\n");
    const changed = runGuarded(home, () => plant(home, target, "after\n"));
    expect(changed).toContain(target);
  });
});
