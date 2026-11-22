// stop-unloaded-launchd-3067.test.ts — flair#3067.
//
// A fresh `flair init` writes the launchd plist but starts Flair directly, so
// the job was never loaded. `flair stop` used to unload that non-existent job,
// then wait the full startup budget for a pid the unload never signalled:
// 60 seconds, exit 1, Flair still running.
//
// These cases drive the real `flair stop` command in a child process whose
// `process.platform` reports darwin. `launchctl` is a shim on PATH answering
// from a state directory this test owns, so no invocation reaches a host
// service manager. The instances are node stubs started by the test: the
// Flair-shaped one exits on SIGTERM, the foreign one records a signal instead.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { launchdLabel, launchdPlistPath } from "../../src/cli.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");

type Fixture = {
  home: string;
  dataDir: string;
  bin: string;
  state: string;
  log: string;
  label: string;
  port: number;
  children: ReturnType<typeof Bun.spawn>[];
};

let fixture: Fixture | undefined;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function makeFixture(): Promise<Fixture> {
  const home = tempDir("stop-3067-");
  const dataDir = join(home, ".flair", "data");
  const agentsDir = join(home, "Library", "LaunchAgents");
  const bin = join(home, "bin");
  const state = join(home, "launchctl-state");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const label = launchdLabel(dataDir);
  writeFileSync(launchdPlistPath(label, agentsDir), "<plist/>");
  const log = join(home, "launchctl.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
verb="$1"
case "$verb" in
  list)
    if [ -f "$LAUNCHCTL_STATE/loaded" ]; then
      printf '{\\n\\t"Label" = "%s";\\n\\t"PID" = %s;\\n};\\n' "$2" "$(cat "$LAUNCHCTL_STATE/pid")"
      exit 0
    fi
    echo "Could not find service \\"$2\\"" >&2
    exit 113 ;;
  unload)
    if [ -f "$LAUNCHCTL_STATE/loaded" ]; then
      kill -TERM "$(cat "$LAUNCHCTL_STATE/pid")" 2>/dev/null
    fi
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  fixture = {
    home, dataDir, bin, state, log, label,
    port: await freePort(),
    children: [],
  };
  return fixture;
}

/** A directly started instance: records its pid, then dies on SIGTERM. */
async function startFlairStub(f: Fixture): Promise<number> {
  const script = join(f.home, "flair-stub.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(process.env.FLAIR_PIDFILE, String(process.pid));
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: { ...process.env, FLAIR_PIDFILE: join(f.dataDir, "hdb.pid") },
    stdout: "ignore", stderr: "ignore",
  });
  f.children.push(child);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.dataDir, "hdb.pid")) && Date.now() < deadline) await Bun.sleep(10);
  const pid = Number(readFileSync(join(f.dataDir, "hdb.pid"), "utf8"));
  writeFileSync(join(f.dataDir, "flair-daemon.json"), JSON.stringify({
    pid, startTimeMs: Date.now(), port: f.port, flairVersion: "test",
  }));
  return pid;
}

/** A live process that is not Flair's and records any signal it receives. */
async function startForeignStub(f: Fixture): Promise<number> {
  const script = join(f.home, "foreign-stub.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(process.env.SIGNAL_FILE, 'SIGTERM'));
fs.writeFileSync(process.env.FOREIGN_PIDFILE, String(process.pid));
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: { ...process.env, SIGNAL_FILE: join(f.home, "signalled"), FOREIGN_PIDFILE: join(f.dataDir, "hdb.pid") },
    stdout: "ignore", stderr: "ignore",
  });
  f.children.push(child);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.dataDir, "hdb.pid")) && Date.now() < deadline) await Bun.sleep(10);
  return Number(readFileSync(join(f.dataDir, "hdb.pid"), "utf8"));
}

async function runStop(f: Fixture): Promise<{ out: string; code: number; elapsed: number }> {
  const runner = join(f.home, "stop-runner.mjs");
  writeFileSync(runner, `
const { program } = await import(${JSON.stringify(join(repoRoot, "src/cli.ts"))});
Object.defineProperty(process, 'platform', { value: 'darwin' });
await program.parseAsync(['bun', 'flair', 'stop', '--port', process.env.TEST_PORT]);
`);
  const started = Date.now();
  const proc = Bun.spawn(["bun", runner], {
    cwd: repoRoot,
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: f.home,
      TEST_PORT: String(f.port),
      LAUNCHCTL_LOG: f.log,
      LAUNCHCTL_STATE: f.state,
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: stdout + stderr, code, elapsed: Date.now() - started };
}

function unloadCalls(f: Fixture): string[] {
  return readFileSync(f.log, "utf8").split("\n").filter((line) => line.startsWith("unload "));
}

afterEach(() => {
  for (const child of fixture?.children ?? []) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  fixture = undefined;
});

describe("flair#3067 — stop when the launchd job was never loaded", () => {
  test("a fresh init's directly started process stops without the 60s wait", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f);
    // The job is not loaded: the shim's `list` exits 113.
    const result = await runStop(f);
    if (result.code !== 0) throw new Error(`stop exited ${result.code}: ${result.out}`);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`stopped the directly started Flair (pid ${pid})`);
    expect(result.out).toContain(`the launchd job ${f.label} was not loaded`);
    expect(result.elapsed).toBeLessThan(10_000);
    expect(unloadCalls(f)).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  test("a loaded job still takes the unload path", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f);
    writeFileSync(join(f.state, "loaded"), "1");
    writeFileSync(join(f.state, "pid"), String(pid));
    const result = await runStop(f);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Flair stopped (launchd service unloaded)");
    expect(unloadCalls(f)).toHaveLength(1);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  test("a recorded pid that is not Flair's is never signalled", async () => {
    const f = await makeFixture();
    const pid = await startForeignStub(f);
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`refusing to signal pid ${pid}`);
    expect(result.out).toContain("not verifiably Flair's");
    expect(result.out).toContain("flair doctor");
    expect(existsSync(join(f.home, "signalled"))).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(unloadCalls(f)).toEqual([]);
  }, 30_000);
});
