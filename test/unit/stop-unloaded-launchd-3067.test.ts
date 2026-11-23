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
// service manager. The instances are node stubs started by the test: a
// synthetic fresh-init one serves Flair's real /Health body and exits on
// SIGTERM; the foreign one records a signal instead.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { launchdLabel, launchdPlistPath } from "../../src/cli.ts";
import { buildPublicHealthBody } from "../../resources/search-readiness.ts";

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
    if [ -f "$LAUNCHCTL_STATE/fail" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
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

/** A directly started instance: serves Flair's /Health, records its pid, dies on SIGTERM. */
async function startFlairStub(f: Fixture): Promise<number> {
  const script = join(f.home, "flair-stub.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
const http = require('node:http');
const body = fs.readFileSync(process.env.HEALTH_BODY_FILE, 'utf8');
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}).listen(Number(process.env.HTTP_PORT), '127.0.0.1', () => {
  fs.writeFileSync(process.env.FLAIR_PIDFILE, String(process.pid));
});
setInterval(() => {}, 1000);
`);
  // Built by the module the server's Health resource uses, so the classifier
  // sees the real /Health fingerprint and takes the RUNNING arm.
  const healthBody = join(f.home, "health-body.json");
  writeFileSync(healthBody, JSON.stringify(buildPublicHealthBody(
    { searchReady: true, ok: true, status: 200 },
    { version: "0.53.0", buildCommit: null },
  )));
  const child = Bun.spawn(["node", script], {
    env: {
      ...process.env,
      FLAIR_PIDFILE: join(f.dataDir, "hdb.pid"),
      HEALTH_BODY_FILE: healthBody,
      HTTP_PORT: String(f.port),
    },
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

/** A live process that is not recorded as Flair's and records any signal it receives. */
async function startSentinel(f: Fixture): Promise<number> {
  const script = join(f.home, "sentinel.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(process.env.SENTINEL_SIGNAL, 'SIGTERM'));
fs.writeFileSync(process.env.SENTINEL_READY, '1');
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: {
      ...process.env,
      SENTINEL_SIGNAL: join(f.home, "sentinel-signalled"),
      SENTINEL_READY: join(f.home, "sentinel-ready"),
    },
    stdout: "ignore", stderr: "ignore",
  });
  f.children.push(child);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.home, "sentinel-ready")) && Date.now() < deadline) await Bun.sleep(10);
  return child.pid;
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
  test("a synthetic fresh-init state whose process serves /Health stops as RUNNING without the 60s wait", async () => {
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

  test("a recorded pid that is not Flair's is left unsignalled", async () => {
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

  test("plist on disk, job not loaded, no pidfile, port free: refuses and names the start command", async () => {
    const f = await makeFixture();
    const sentinel = await startSentinel(f);
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`the launchd job ${f.label} is not loaded`);
    expect(result.out).toContain("records no live Flair process");
    expect(result.out).toContain("flair start");
    expect(unloadCalls(f)).toEqual([]);
    expect(existsSync(join(f.home, "sentinel-signalled"))).toBe(false);
    expect(() => process.kill(sentinel, 0)).not.toThrow();
  }, 30_000);

  test("a failed launchctl list is not read as not-loaded: stop refuses", async () => {
    const f = await makeFixture();
    writeFileSync(join(f.state, "fail"), "1");
    const sentinel = await startSentinel(f);
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain("could not read whether the launchd job");
    expect(result.out).toContain("flair doctor");
    expect(unloadCalls(f)).toEqual([]);
    expect(existsSync(join(f.home, "sentinel-signalled"))).toBe(false);
    expect(() => process.kill(sentinel, 0)).not.toThrow();
  }, 30_000);

  test("no listener and an unreadable pidfile: no Flair process is named", async () => {
    const f = await makeFixture();
    // A dangling symlink makes the pidfile unreadable for every uid, root included.
    symlinkSync(join(f.home, "missing-target"), join(f.dataDir, "hdb.pid"));
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain("no Flair process could be identified");
    expect(result.out).not.toContain("the process serving the port");
    expect(unloadCalls(f)).toEqual([]);
  }, 30_000);
});
