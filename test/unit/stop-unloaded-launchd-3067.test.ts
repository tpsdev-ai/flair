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
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { launchdLabel, launchdPlistPath } from "../../src/cli.ts";
import { buildPublicHealthBody } from "../../resources/search-readiness.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");

/** Stub prelude: publish a state file atomically, so a reader that sees the
 *  path never sees a created-but-empty file. */
const PUBLISH = `
function publish(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
`;

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
    n=0
    if [ -f "$LAUNCHCTL_STATE/list-count" ]; then n=$(cat "$LAUNCHCTL_STATE/list-count"); fi
    n=$((n+1))
    printf '%s' "$n" > "$LAUNCHCTL_STATE/list-count"
    if [ -f "$LAUNCHCTL_STATE/later-fail" ] && [ "$n" -ge 2 ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    if [ -f "$LAUNCHCTL_STATE/later-loaded" ] && [ "$n" -ge 2 ]; then
      printf '{\\n\\t"Label" = "%s";\\n\\t"PID" = %s;\\n};\\n' "$2" "$(cat "$LAUNCHCTL_STATE/pid")"
      exit 0
    fi
    if [ -f "$LAUNCHCTL_STATE/loaded" ]; then
      printf '{\\n\\t"Label" = "%s";\\n\\t"PID" = %s;\\n};\\n' "$2" "$(cat "$LAUNCHCTL_STATE/pid")"
      exit 0
    fi
    echo "Could not find service \\"$2\\"" >&2
    exit 113 ;;
  unload)
    rm -f "$LAUNCHCTL_STATE/loaded" "$LAUNCHCTL_STATE/later-loaded" "$LAUNCHCTL_STATE/later-fail" "$LAUNCHCTL_STATE/fail"
    if [ -f "$LAUNCHCTL_STATE/pid" ]; then
      kill -TERM "$(cat "$LAUNCHCTL_STATE/pid")" 2>/dev/null
      rm -f "$LAUNCHCTL_STATE/pid"
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

/** A directly started instance: serves Flair's /Health, records its pid, dies on SIGTERM.
 *  With `successor: "serving"`, SIGTERM closes its listener and keeps the process
 *  alive until a successor it spawns answers /Health on the same port, so that
 *  successor is serving when the recorded pid exits; in `serving` mode the
 *  successor records its own pid and sidecar only once the test writes
 *  `successor-record-trigger`.
 *  With `successor: "serving-recorded"` it records them before it starts
 *  listening, so they are on disk before the first stop's final evidence read.
 *  With `successor: "silent"` the successor accepts TCP but never answers
 *  /Health. The stub exits once the successor reports ready, or after 5 seconds
 *  whether or not it did. */
async function startFlairStub(f: Fixture, opts: { successor?: "serving" | "serving-recorded" | "silent" } = {}): Promise<number> {
  const script = join(f.home, "flair-stub.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
const http = require('node:http');
${PUBLISH}
const body = fs.readFileSync(process.env.HEALTH_BODY_FILE, 'utf8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
});
server.listen(Number(process.env.HTTP_PORT), '127.0.0.1', () => {
  publish(process.env.FLAIR_PIDFILE, String(process.pid));
});
if (process.env.SUCCESSOR_SCRIPT) {
  process.on('SIGTERM', () => {
    try { server.close(); } catch {}
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [process.env.SUCCESSOR_SCRIPT], {
      env: process.env, detached: true, stdio: 'ignore',
    });
    child.unref();
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.SUCCESSOR_READY_FILE) || Date.now() > deadline) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 10);
  });
}
setInterval(() => {}, 1000);
`);
  // Built by the module the server's Health resource uses, so the classifier
  // sees the real /Health fingerprint and takes the RUNNING arm.
  const healthBody = join(f.home, "health-body.json");
  writeFileSync(healthBody, JSON.stringify(buildPublicHealthBody(
    { searchReady: true, ok: true, status: 200 },
    { version: "0.53.0", buildCommit: null },
  )));
  let successorScript: string | undefined;
  if (opts.successor) {
    successorScript = join(f.home, "successor-stub.cjs");
    writeFileSync(successorScript, opts.successor === "silent" ? `
const fs = require('node:fs');
const net = require('node:net');
${PUBLISH}
publish(process.env.SUCCESSOR_PID_FILE, String(process.pid));
function start() {
  const server = net.createServer(() => {});
  server.on('error', () => setTimeout(start, 25));
  server.listen(Number(process.env.HTTP_PORT), '127.0.0.1', () => {
    publish(process.env.SUCCESSOR_READY_FILE, '1');
  });
}
start();
setInterval(() => {}, 1000);
` : `
const fs = require('node:fs');
const http = require('node:http');
const body = fs.readFileSync(process.env.HEALTH_BODY_FILE, 'utf8');
${PUBLISH}
publish(process.env.SUCCESSOR_PID_FILE, String(process.pid));
// Simulated startup writes: Harper records its pid in hdb.pid, while Flair
// records the identity sidecar. A later flair stop acts on that pair. In the
// "serving" mode the test triggers both writes; in "serving-recorded" they
// land here, before the listener starts, so they precede the ready file.
const record = () => {
  publish(process.env.FLAIR_PIDFILE, String(process.pid));
  publish(process.env.SIDECAR_FILE, JSON.stringify({
    pid: process.pid,
    startTimeMs: Math.round(Date.now() - process.uptime() * 1000),
    port: Number(process.env.HTTP_PORT),
    flairVersion: 'test',
  }));
  publish(process.env.SUCCESSOR_RECORDED_FILE, '1');
};
${opts.successor === "serving-recorded" ? "record();" : `const recorder = setInterval(() => {
  if (!fs.existsSync(process.env.SUCCESSOR_RECORD_TRIGGER)) return;
  clearInterval(recorder);
  record();
}, 25);`}
function start() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  server.on('error', () => setTimeout(start, 25));
  server.listen(Number(process.env.HTTP_PORT), '127.0.0.1', () => {
    publish(process.env.SUCCESSOR_READY_FILE, '1');
  });
}
start();
setInterval(() => {}, 1000);
`);
  }
  const child = Bun.spawn(["node", script], {
    env: {
      ...process.env,
      FLAIR_PIDFILE: join(f.dataDir, "hdb.pid"),
      HEALTH_BODY_FILE: healthBody,
      HTTP_PORT: String(f.port),
      ...(successorScript ? {
        SUCCESSOR_SCRIPT: successorScript,
        SUCCESSOR_PID_FILE: join(f.home, "successor.pid"),
        SUCCESSOR_READY_FILE: join(f.home, "successor-ready"),
        SIDECAR_FILE: join(f.dataDir, "flair-daemon.json"),
        SUCCESSOR_RECORD_TRIGGER: join(f.home, "successor-record-trigger"),
        SUCCESSOR_RECORDED_FILE: join(f.home, "successor-recorded"),
      } : {}),
    },
    stdout: "ignore", stderr: "ignore",
  });
  f.children.push(child);
  const pid = await waitForPidFile(join(f.dataDir, "hdb.pid"));
  publishFile(join(f.dataDir, "flair-daemon.json"), JSON.stringify({
    pid, startTimeMs: Date.now(), port: f.port, flairVersion: "test",
  }));
  return pid;
}

/** A live process that is not Flair's and records SIGTERM if received. */
async function startForeignStub(f: Fixture): Promise<number> {
  const script = join(f.home, "foreign-stub.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
${PUBLISH}
process.on('SIGTERM', () => publish(process.env.SIGNAL_FILE, 'SIGTERM'));
publish(process.env.FOREIGN_PIDFILE, String(process.pid));
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: { ...process.env, SIGNAL_FILE: join(f.home, "signalled"), FOREIGN_PIDFILE: join(f.dataDir, "hdb.pid") },
    stdout: "ignore", stderr: "ignore",
  });
  f.children.push(child);
  return await waitForPidFile(join(f.dataDir, "hdb.pid"));
}

/** A live process that is not recorded as Flair's and records SIGTERM if received. */
async function startSentinel(f: Fixture): Promise<number> {
  const script = join(f.home, "sentinel.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
${PUBLISH}
process.on('SIGTERM', () => publish(process.env.SENTINEL_SIGNAL, 'SIGTERM'));
publish(process.env.SENTINEL_READY, '1');
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
  await waitForFileContent(join(f.home, "sentinel-ready"), "1");
  return child.pid;
}

/** A live process recorded as Flair's by hdb.pid and its sidecar, but not serving the port. */
async function startWedgedStub(f: Fixture): Promise<number> {
  const script = join(f.home, "wedged-stub.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
${PUBLISH}
publish(process.env.WEDGED_PIDFILE, String(process.pid));
publish(process.env.WEDGED_READY, '1');
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: {
      ...process.env,
      WEDGED_PIDFILE: join(f.dataDir, "hdb.pid"),
      WEDGED_READY: join(f.home, "wedged-ready"),
    },
    stdout: "ignore", stderr: "ignore",
  });
  f.children.push(child);
  await waitForFileContent(join(f.home, "wedged-ready"), "1");
  const pid = await waitForPidFile(join(f.dataDir, "hdb.pid"));
  publishFile(join(f.dataDir, "flair-daemon.json"), JSON.stringify({
    pid, startTimeMs: Date.now(), port: f.port, flairVersion: "test",
  }));
  return pid;
}

async function runStop(f: Fixture, loadDuringFinalEvidence = false): Promise<{ out: string; code: number; elapsed: number }> {
  const runner = join(f.home, "stop-runner.mjs");
  writeFileSync(runner, `
const { program } = await import(${JSON.stringify(join(repoRoot, "src/cli.ts"))});
Object.defineProperty(process, 'platform', { value: 'darwin' });
${loadDuringFinalEvidence ? `
const { writeFileSync } = await import('node:fs');
const originalFetch = globalThis.fetch;
let healthCalls = 0;
globalThis.fetch = async (...args) => {
  if (++healthCalls === 2) {
    await Promise.resolve();
    writeFileSync(process.env.LAUNCHCTL_STATE + '/loaded', '1');
  }
  return originalFetch(...args);
};
` : ''}
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

function publishFile(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** Wait for `path` to hold a complete positive pid. A create-before-write
 *  window reads as "", which is why a bare existsSync-then-read can see 0. */
async function waitForPidFile(path: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = "missing";
  for (;;) {
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error(`pid-file-unreadable: ${path}: ${String(error)}`);
      }
    }
    if (text !== undefined) {
      last = JSON.stringify(text);
      const pid = Number(text);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    if (Date.now() >= deadline) {
      const error = new Error(`pid-file-not-ready: ${path} held no pid within ${timeoutMs}ms (last read ${last})`);
      error.name = "PidFileNotReadyError";
      throw error;
    }
    await Bun.sleep(10);
  }
}

async function waitForFileContent(path: string, expected: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "missing";
  for (;;) {
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw new Error(`file-unreadable: ${path}: ${String(error)}`);
    }
    if (text === expected) return;
    if (text !== undefined) last = JSON.stringify(text);
    if (Date.now() >= deadline) {
      const error = new Error(`file-content-not-ready: ${path} did not read ${JSON.stringify(expected)} within ${timeoutMs}ms (last read ${last})`);
      error.name = "FileContentNotReadyError";
      throw error;
    }
    await Bun.sleep(10);
  }
}

/** A live process that creates its pid file empty and fills it 200 ms later:
 *  the create-then-write window a plain writeFileSync exposes. */
async function startDelayedPidStub(f: Fixture): Promise<{ pid: number; childPid: number }> {
  const script = join(f.home, "delayed-pid-stub.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
const fd = fs.openSync(process.env.DELAYED_PID_FILE, 'w');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
fs.writeSync(fd, String(process.pid));
fs.closeSync(fd);
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: { ...process.env, DELAYED_PID_FILE: join(f.home, "delayed.pid") },
    stdout: "ignore", stderr: "ignore",
  });
  f.children.push(child);
  return { pid: await waitForPidFile(join(f.home, "delayed.pid")), childPid: child.pid };
}

afterEach(() => {
  for (const child of fixture?.children ?? []) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  // A successor stub is spawned detached by the instance stub, so it is not in
  // `children`; kill the pid it recorded, if it got that far.
  const successorPidFile = fixture ? join(fixture.home, "successor.pid") : null;
  if (successorPidFile) {
    let successorPid = 0;
    try { successorPid = Number(readFileSync(successorPidFile, "utf8")); } catch { /* not recorded */ }
    if (Number.isInteger(successorPid) && successorPid > 0) {
      try { process.kill(successorPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  fixture = undefined;
});

describe("flair#3067 — stop when the launchd job was never loaded", () => {
  test("a pid file created empty and filled 200 ms later yields the real pid, not 0", async () => {
    const f = await makeFixture();
    const { pid, childPid } = await startDelayedPidStub(f);
    expect(pid).toBe(childPid);
  }, 30_000);

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

  test("a job that is loaded during the stop is not reported as stopped, and a re-run takes the unload path", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f);
    // The first `launchctl list` answers 113; after the recorded pid exits the
    // next read reports the job loaded, so the stop did not leave it unloaded.
    writeFileSync(join(f.state, "later-loaded"), "1");
    writeFileSync(join(f.state, "pid"), String(pid));
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`pid ${pid} exited, but Flair is not confirmed down`);
    expect(result.out).toContain("now reads loaded");
    expect(result.out).not.toContain("stopped the directly started Flair");
    expect(result.out).toContain("Run 'flair stop' again to take the unload path.");
    expect(result.out).toContain("the instance reads NOT_RUNNING");
    expect(result.out).toContain("flair doctor");
    expect(result.out).not.toContain("undefined");

    // The named step: a second `flair stop` reads the job loaded and unloads it.
    const again = await runStop(f);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Flair stopped (launchd service unloaded)");
    expect(unloadCalls(f)).toHaveLength(1);
    expect(existsSync(join(f.state, "loaded"))).toBe(false);
    expect(existsSync(join(f.state, "later-loaded"))).toBe(false);
  }, 30_000);

  test("a job loaded during the final evidence gather is not reported as stopped", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f);
    writeFileSync(join(f.state, "pid"), String(pid));
    const result = await runStop(f, true);
    expect(existsSync(join(f.state, "loaded"))).toBe(true);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`pid ${pid} exited, but Flair is not confirmed down`);
    expect(result.out).toContain("now reads loaded");
    expect(result.out).toContain("the instance reads NOT_RUNNING");
    expect(result.out).toContain("Run 'flair stop' again to take the unload path.");
    expect(result.out).not.toContain("stopped the directly started Flair");
    expect(unloadCalls(f)).toEqual([]);
  }, 30_000);

  test("a successor serving /Health after the recorded pid exits is not reported as stopped, and a re-run resolves once its identity is recorded", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f, { successor: "serving" });
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`pid ${pid} exited, but Flair is not confirmed down`);
    expect(result.out).toContain("the instance reads DISAGREEMENT");
    expect(result.out).toContain(`a process is serving port ${f.port}, but the recorded pid ${pid} is not alive`);
    expect(result.out).not.toContain("stopped the directly started Flair");
    expect(result.out).toContain("flair doctor");
    expect(result.out).not.toContain("Run 'flair stop' again to stop the verified recorded pid");

    const successorPidFile = join(f.home, "successor.pid");
    const successorPid = await waitForPidFile(successorPidFile);

    // Before its identity is recorded, a repeat refuses and signals nothing.
    const beforeRecording = await runStop(f);
    expect(beforeRecording.code).toBe(1);
    expect(beforeRecording.out).not.toContain("stopped the directly started Flair");
    expect(beforeRecording.out).not.toContain("Run 'flair stop' again to stop the verified recorded pid");
    expect(() => process.kill(successorPid, 0)).not.toThrow();

    // Once the simulated startup writes have recorded the successor (Harper's
    // pid, Flair's identity sidecar), a re-run verifies and signals it.
    writeFileSync(join(f.home, "successor-record-trigger"), "1");
    await waitForFileContent(join(f.home, "successor-recorded"), "1");
    const again = await runStop(f);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`stopped the directly started Flair (pid ${successorPid})`);
    expect(() => process.kill(successorPid, 0)).toThrow();
    expect(unloadCalls(f)).toEqual([]);
  }, 30_000);

  test("a successor that records its identity before the final evidence read is RUNNING, names the resolving step, and a re-run stops its verified pid", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f, { successor: "serving-recorded" });
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`pid ${pid} exited, but Flair is not confirmed down`);
    expect(result.out).toContain("the instance reads RUNNING");
    expect(result.out).toContain("Run 'flair stop' again to stop the verified recorded pid (the instance has recorded its identity).");
    expect(result.out).not.toContain("stopped the directly started Flair");

    const successorPid = await waitForPidFile(join(f.home, "successor.pid"));
    const again = await runStop(f);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`stopped the directly started Flair (pid ${successorPid})`);
    expect(() => process.kill(successorPid, 0)).toThrow();
    expect(unloadCalls(f)).toEqual([]);
  }, 30_000);

  test("a failed launchctl read after the recorded pid exits is not reported as stopped", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f);
    // The first `launchctl list` answers 113; the re-check after the recorded
    // pid exits fails, so the job's state is unknown rather than not-loaded.
    writeFileSync(join(f.state, "later-fail"), "1");
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`pid ${pid} exited, but Flair is not confirmed down`);
    expect(result.out).toContain("now reads unknown");
    expect(result.out).toContain("the instance reads NOT_RUNNING");
    expect(result.out).not.toContain("stopped the directly started Flair");
    expect(result.out).toContain("Inspect it with: flair doctor");
    expect(result.out).not.toContain("Run 'flair stop' again");
  }, 30_000);

  test("a successor that accepts TCP but answers no HTTP after the recorded pid exits is not reported as stopped", async () => {
    const f = await makeFixture();
    const pid = await startFlairStub(f, { successor: "silent" });
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`pid ${pid} exited, but Flair is not confirmed down`);
    expect(result.out).toContain("now reads not-loaded");
    expect(result.out).toContain("the instance reads UNKNOWN");
    expect(result.out).toContain(`could not determine whether Flair is running: recorded pid ${pid} is not alive and the health check on port ${f.port} did not respond`);
    expect(result.out).not.toContain("stopped the directly started Flair");
    expect(result.out).toContain("Inspect it with: flair doctor");
    expect(result.out).not.toContain("Run 'flair stop' again");
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

  test("a failed launchctl list is not read as not-loaded: stop refuses to signal a recorded pid", async () => {
    const f = await makeFixture();
    writeFileSync(join(f.state, "fail"), "1");
    const pid = await startForeignStub(f);
    const result = await runStop(f);
    expect(result.code).toBe(1);
    expect(result.out).toContain("could not read whether the launchd job");
    expect(result.out).toContain("flair doctor");
    expect(unloadCalls(f)).toEqual([]);
    expect(existsSync(join(f.home, "signalled"))).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 30_000);

  test("an unloaded job with a verified recorded pid that is not serving stops directly (WEDGED)", async () => {
    const f = await makeFixture();
    const pid = await startWedgedStub(f);
    const result = await runStop(f);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`stopped the directly started Flair (pid ${pid})`);
    expect(result.out).toContain(`the launchd job ${f.label} was not loaded`);
    expect(unloadCalls(f)).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
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
