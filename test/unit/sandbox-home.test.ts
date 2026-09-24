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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  CLAUDE_JSON_SUBTREE,
  REAL_CLIENT_CONFIGS,
  changedConfigs,
  runGuarded,
  snapshotClientConfigs,
} from "../../scripts/home-isolation-guard.ts";

const GUARD = join(import.meta.dir, "..", "..", "scripts", "home-isolation-guard.ts");

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

  it("treats a projects-only ~/.claude.json as the same (absent) mcpServers subtree", () => {
    const home = fakeHome();
    const before = snapshotClientConfigs(home); // no ~/.claude.json at all
    // Claude Code creates ~/.claude.json with only a `projects` key long before
    // it writes any mcpServers. The subtree is unchanged (none) — this must NOT
    // read as a change.
    plant(home, ".claude.json", JSON.stringify({ projects: { a: 1 } }));
    expect(changedConfigs(before, snapshotClientConfigs(home))).toEqual([]);
    // Actually writing mcpServers IS a change.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { a: 1 }, mcpServers: {} }));
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

describe("realHomeDir ignores a swapped HOME (flair#1854 follow-up)", () => {
  it("resolves the real home even when the process STARTS with HOME pointed elsewhere", () => {
    // The lane runs under Bun, and Bun's os.userInfo().homedir follows the HOME
    // the process STARTED with — so a lane launched with a sandbox HOME would
    // fingerprint the sandbox and miss a real write. Start a child process with a
    // swapped HOME and assert the guard still names the passwd home.
    const sandbox = fakeHome();
    const probe = join(sandbox, "probe-real-home.ts");
    writeFileSync(probe, `import { realHomeDir } from ${JSON.stringify(GUARD)};\nprocess.stdout.write(realHomeDir());\n`);
    const swapped = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, PI_CODING_AGENT_DIR: sandbox };

    const viaBun = spawnSync("bun", [probe], { encoding: "utf8", env: swapped });
    expect(viaBun.status).toBe(0);
    const got = viaBun.stdout.trim();

    // The passwd answer: node ignores HOME entirely.
    const refEnv: NodeJS.ProcessEnv = { ...swapped };
    delete refEnv.HOME;
    delete refEnv.USERPROFILE;
    const realHome = execFileSync("node", ["-p", "require('node:os').userInfo().homedir"], {
      encoding: "utf8",
      env: refEnv,
    }).trim();

    expect(got).toBe(realHome);
    expect(got).not.toBe(sandbox);
  });

  it("FAILS CLOSED when node cannot answer — never falls back to the sandbox-following in-process value", () => {
    // Before the fix, a failed or missing `node` fell back to Bun's in-process
    // os.userInfo().homedir, which follows the swapped HOME: the guard then
    // fingerprinted the SANDBOX and passed after a real config change.
    const sandbox = fakeHome();
    const probe = join(sandbox, "probe-real-home.ts");
    writeFileSync(probe, `import { realHomeDir } from ${JSON.stringify(GUARD)};\nprocess.stdout.write(realHomeDir());\n`);
    const emptyBin = fakeHome(); // a PATH with no node on it
    const noNode = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, PI_CODING_AGENT_DIR: sandbox, PATH: emptyBin };

    const r = spawnSync(process.execPath, [probe], { encoding: "utf8", env: noNode });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain(sandbox);
    expect(`${r.stderr}${r.stdout}`).toContain("cannot resolve the real home directory");
  });
});

// ── flair#1865: the node probe is bounded, and its refusal branches are
// exercised directly ───────────────────────────────────────────────────────
//
// Neither the "node returned an empty home" branch nor a hung `node` (the
// timeout case) can be triggered with the real node, so each test puts a shim
// `node` first on PATH and points HOME/USERPROFILE/PI_CODING_AGENT_DIR at a
// throwaway dir BEFORE the probe starts. The swapped HOME must never reach
// stdout: it is the value the guard refuses to return.

/** A temp dir whose only binary is a shim `node`, executable, behaving as `kind`. */
function nodeShimBin(kind: "empty" | "hang"): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-guard-node-shim-"));
  fixtures.push(dir);
  const shimPath = join(dir, "node");
  const body =
     kind === "empty"
        ? "#!/bin/sh\nexit 0\n"
         : "#!/bin/sh\nsleep 30\nexit 0\n";
  writeFileSync(shimPath, body, { mode: 0o755 });
  return dir;
}

/**
 * Run the `realHomeDir()` probe as a detached child, with a swapped HOME and a
 * shim `node` first on PATH. Returns its exit status and captured output. The
 * probe is detached so a hung shim can be reaped by killing the whole group.
 */
function runRealHomeProbe(
  swappedHome: string,
  shimDir: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const probe = join(swappedHome, "probe-real-home.ts");
  writeFileSync(probe, `import { realHomeDir } from ${JSON.stringify(GUARD)};\nprocess.stdout.write(realHomeDir());\n`);
  const env: NodeJS.ProcessEnv = {
     ...process.env,
    HOME: swappedHome,
    USERPROFILE: swappedHome,
    PI_CODING_AGENT_DIR: swappedHome,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
   };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probe], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
     // A hung shim leaves an orphaned `sleep` in the group; kill the whole group
     // when either the probe closes or the safety-net deadline fires.
    const sweepGroup = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const guard = setTimeout(sweepGroup, 22_000);
    child.on("close", (code) => {
      sweepGroup();
      clearTimeout(guard);
      resolve({ status: code, stdout: out, stderr: err });
    });
   });
}

describe("realHomeDir fails closed against a shim node (flair#1865)", () => {
  it("refuses when the shim node returns an empty home (exits 0, no output)", async () => {
    const home = fakeHome();
    const shim = nodeShimBin("empty");
    const r = await runRealHomeProbe(home, shim);
    expect(r.status).not.toBe(0);
     // The swapped HOME was never resolved, so it cannot appear on stdout.
    expect(r.stdout).not.toContain(home);
    expect(`${r.stderr}${r.stdout}`).toContain("returned an empty home directory");
   });

  it("fails closed (not a hang) when the shim node sleeps past the probe timeout", async () => {
    const home = fakeHome();
    const shim = nodeShimBin("hang");
     // With the fix the probe times out at ~10 s, well under the 20 s deadline.
     // Without it, execFileSync has no timeout: the probe blocks for the full 30 s
     // sleep and this test TIMES OUT at 20 s — that timeout IS the red.
    const r = await runRealHomeProbe(home, shim);
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toContain("cannot resolve the real home directory");
   }, 20_000);
});
