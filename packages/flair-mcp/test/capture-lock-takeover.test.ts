import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_LOCK_STALE_MS, flushLockPath, lockPath, runCapture, runCaptureFlush } from "../src/capture-spool.ts";

const CAPTURE_CHILD = `
const { mock } = await import("bun:test");
const fs = await import("node:fs");
const real = { ...fs };
let failed = false;
mock.module("node:fs", () => ({ ...real,
  writeFileSync(path, data, ...args) {
    if (process.env.FAIL_CREATE === "1" && typeof path === "number" && !failed) {
      failed = true;
      real.writeFileSync(path, "{");
      throw new Error("identity write failed");
    }
    return real.writeFileSync(path, data, ...args);
  },
}));
const warnings = [];
console.warn = message => warnings.push(message);
const { runCapture } = await import(process.env.CAPTURE_TEST_MODULE);
const dir = process.env.CAPTURE_TEST_DIR;
const input = JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-a." });
const result = runCapture(input, { dir, env: { FLAIR_AGENT_ID: "agent", HOME: process.env.HOME } });
const lockExists = real.existsSync(dir + "/agent.lock");
const retry = process.env.FAIL_CREATE === "1" ? runCapture(input, { dir, env: { FLAIR_AGENT_ID: "agent" } }) : null;
process.stdout.write(JSON.stringify({ result, warnings, lockExists, retry }));
`;

async function captureChild(home: string, dir: string, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["-e", CAPTURE_CHILD], {
    env: { ...process.env, HOME: home, CAPTURE_TEST_DIR: dir, ...extra,
      CAPTURE_TEST_MODULE: new URL("../src/capture-spool.ts", import.meta.url).pathname },
    timeout: 5000,
  });
  let output = "";
  let errors = "";
  child.stdout!.on("data", (data) => { output += data; });
  child.stderr!.on("data", (data) => { errors += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(errors).toBe("");
  expect(code).toBe(0);
  return JSON.parse(output);
}

for (const content of ["", "{", "unreadable"]) {
  test(`an aged ${content === "" ? "empty" : content === "{" ? "partial" : content} lock is reclaimed`, async () => {
    const home = mkdtempSync(join(tmpdir(), "flair-stale-home-"));
    const dir = join(home, ".flair", "capture");
    try {
      mkdirSync(dir, { recursive: true });
      const lock = lockPath(dir, "agent");
      writeFileSync(lock, content, { flag: "wx", mode: 0o600 });
      if (content === "unreadable") chmodSync(lock, 0o000);
      const old = new Date(Date.now() - CAPTURE_LOCK_STALE_MS - 1000);
      utimesSync(lock, old, old);
      const outcome = await captureChild(home, dir);
      expect(outcome.result.reason).toBe("appended");
      expect(outcome.lockExists).toBe(false);
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0]).toMatch(/capture lock reclaimed \(age \d+ ms\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
}

test("a failed identity write removes the created lock before the next capture", async () => {
  const home = mkdtempSync(join(tmpdir(), "flair-create-home-"));
  try {
    const outcome = await captureChild(home, join(home, ".flair", "capture"), { FAIL_CREATE: "1" });
    expect(outcome.result.reason).toBe("refused");
    expect(outcome.lockExists).toBe(false);
    expect(outcome.retry.reason).toBe("appended");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10_000);

test("an aged lock with an unrelated live pid is reclaimed with its age warning", async () => {
  const home = mkdtempSync(join(tmpdir(), "flair-live-pid-home-"));
  const dir = join(home, ".flair", "capture");
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], {
    env: { ...process.env, HOME: home }, timeout: 10_000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
    });
    mkdirSync(dir, { recursive: true });
    const lock = lockPath(dir, "agent");
    writeFileSync(lock, JSON.stringify({ pid: child.pid, nonce: "unrelated" }), { flag: "wx", mode: 0o600 });
    const old = new Date(Date.now() - CAPTURE_LOCK_STALE_MS - 1000);
    utimesSync(lock, old, old);
    process.kill(child.pid!, 0);
    const outcome = await captureChild(home, dir);
    expect(outcome.result.reason).toBe("appended");
    expect(outcome.lockExists).toBe(false);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toMatch(/capture lock reclaimed \(age \d+ ms\)/);
    process.kill(child.pid!, 0);
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);

const CONTENDER = `
const { mock } = await import("bun:test");
const fs = await import("node:fs");
const real = { ...fs };
const { join } = await import("node:path");
const dir = process.env.CAPTURE_TEST_DIR;
const lock = join(dir, process.env.LOCK_KIND === "append" ? "agent.lock" : "agent.flush.lock");
const cell = new Int32Array(new SharedArrayBuffer(4));
function wait(path) {
  const deadline = Date.now() + 8000;
  while (!real.existsSync(path)) {
    if (Date.now() > deadline) throw new Error("barrier timeout: " + path);
    Atomics.wait(cell, 0, 0, 2);
  }
}
let paused = false;
let observed = false;
const descriptors = new Map();
function beforeTakeover() {
  if (process.env.CONTENDER === "a" && !paused) {
    paused = true;
    real.writeFileSync(join(dir, "a-validated"), "");
    wait(join(dir, "resume-a"));
  }
}
function afterAction() {
  if (process.env.PROBE === "1" && process.env.CONTENDER === "a" && !observed) {
    observed = true;
    real.writeFileSync(join(dir, "a-after-action"), "");
    wait(join(dir, "probe-done"));
  }
}
function observeAbsence() {
  if (real.existsSync(join(dir, "b-writing")) && !real.existsSync(join(dir, "finish")) && !real.existsSync(lock)) {
    real.writeFileSync(join(dir, "live-lock-absent"), "");
  }
}
function writing() {
  real.writeFileSync(join(dir, process.env.CONTENDER + "-writing"), "");
  wait(join(dir, "finish"));
}
mock.module("node:fs", () => ({ ...real,
  openSync(path, flags, ...args) {
    if (path === lock + ".takeover" && flags === "wx") beforeTakeover();
    const fd = real.openSync(path, flags, ...args);
    descriptors.set(fd, path);
    return fd;
  },
  readFileSync(path, ...args) {
    const result = real.readFileSync(path, ...args);
    if (paused && descriptors.get(path) === lock) afterAction();
    return result;
  },
  closeSync(fd) { descriptors.delete(fd); return real.closeSync(fd); },
  unlinkSync(path) {
    const result = real.unlinkSync(path);
    if (path === lock) observeAbsence();
    return result;
  },
  renameSync(path, target) {
    if (path === lock) beforeTakeover();
    const result = real.renameSync(path, target);
    if (path === lock) { observeAbsence(); afterAction(); }
    if (process.env.LOCK_KIND === "append" && target === join(dir, "agent.spool.json")) writing();
    return result;
  },
}));
const { runCapture, runCaptureFlush } = await import(process.env.CAPTURE_TEST_MODULE);
const warnings = [];
console.warn = message => warnings.push(message);
const result = process.env.LOCK_KIND === "append"
  ? runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-" + process.env.CONTENDER + "." }), {
      dir, env: { FLAIR_AGENT_ID: "agent" },
    })
  : await runCaptureFlush({ warn: message => warnings.push(message), dir, env: { FLAIR_AGENT_ID: "agent" },
      makeClient: () => ({ request: async () => {
        real.writeFileSync(join(dir, process.env.CONTENDER + "-writing"), "");
        while (!real.existsSync(join(dir, "finish"))) await new Promise(resolve => setTimeout(resolve, 2));
        return {};
      } }),
    });
process.stdout.write(JSON.stringify({ ...result, warnings }));
`;

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

for (const kind of ["append", "flush"]) {
  test(`a delayed ${kind} taker and a third contender keep the live holder locked`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-takeover-"));
    const children: ReturnType<typeof spawn>[] = [];
    try {
      runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-a." }), {
        dir, env: { FLAIR_AGENT_ID: "agent" },
      });
      const dead = spawn(process.execPath, ["-e", ""], { timeout: 1000 });
      await new Promise<void>((resolve) => dead.once("close", () => resolve()));
      const lock = kind === "append" ? lockPath(dir, "agent") : flushLockPath(dir, "agent");
      writeFileSync(lock, JSON.stringify({ pid: dead.pid, nonce: "dead-owner" }), { flag: "wx", mode: 0o600 });
      function contender(name: string) {
        const child = spawn(process.execPath, ["-e", CONTENDER], {
          env: { ...process.env, CONTENDER: name, CAPTURE_TEST_DIR: dir, LOCK_KIND: kind, PROBE: "1",
            CAPTURE_TEST_MODULE: new URL("../src/capture-spool.ts", import.meta.url).pathname },
          timeout: 10_000,
        });
        children.push(child);
        let output = "";
        let errors = "";
        child.stdout!.on("data", (data) => { output += data; });
        child.stderr!.on("data", (data) => { errors += data; });
        return new Promise<string>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors)));
        });
      }
      const a = contender("a");
      void a.catch(() => {});
      await waitFor(join(dir, "a-validated"));
      const b = contender("b");
      void b.catch(() => {});
      await waitFor(join(dir, "b-writing"));
      const survivor = readFileSync(lock, "utf8");
      writeFileSync(join(dir, "resume-a"), "");
      await waitFor(join(dir, "a-after-action"));
      const c = contender("c");
      void c.catch(() => {});
      const third = await Promise.race([
        c.then((output) => JSON.parse(output)),
        waitFor(join(dir, "c-writing")).then(() => ({ reason: "acquired" })),
      ]);
      expect(third.reason).toBe(kind === "append" ? "refused" : "busy");
      expect(readFileSync(lock, "utf8")).toBe(survivor);
      expect(existsSync(join(dir, "live-lock-absent"))).toBe(false);
      writeFileSync(join(dir, "probe-done"), "");
      expect(JSON.parse(await a).reason).toBe(kind === "append" ? "refused" : "busy");
      expect(existsSync(join(dir, "a-writing"))).toBe(false);
      expect(existsSync(join(dir, "c-writing"))).toBe(false);
      expect(readFileSync(lock, "utf8")).toBe(survivor);
      expect(existsSync(join(dir, "live-lock-absent"))).toBe(false);
      writeFileSync(join(dir, "finish"), "");
      const holder = JSON.parse(await b);
      expect(kind === "append" ? holder.reason : holder.flushed).toBe(kind === "append" ? "appended" : 1);
    } finally {
      writeFileSync(join(dir, "finish"), "");
      writeFileSync(join(dir, "resume-a"), "");
      writeFileSync(join(dir, "probe-done"), "");
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
        new Promise<void>((resolve) => child.once("close", () => resolve()))));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
}

for (const scenario of ["inode", "owner", "occupied", "unreadable"]) {
  const unreadable = scenario === "unreadable";
  test(`a changed lock (${scenario}) returns busy without moving it`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-takeover-inode-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-a." }), {
        dir, env: { FLAIR_AGENT_ID: "agent" },
      });
      const dead = spawn(process.execPath, ["-e", ""], { timeout: 1000 });
      await new Promise<void>((resolve) => dead.once("close", () => resolve()));
      const lock = flushLockPath(dir, "agent");
      const identity = JSON.stringify({ pid: dead.pid, nonce: "dead-owner" });
      writeFileSync(lock, identity, { flag: "wx", mode: 0o600 });
      const inode = statSync(lock).ino;
      child = spawn(process.execPath, ["-e", CONTENDER], {
        env: { ...process.env, CONTENDER: "a", CAPTURE_TEST_DIR: dir,
          CAPTURE_TEST_MODULE: new URL("../src/capture-spool.ts", import.meta.url).pathname },
        timeout: 10_000,
      });
      let output = "";
      child.stdout!.on("data", (data) => { output += data; });
      const exited = new Promise<number | null>((resolve) => child!.once("close", resolve));
      await waitFor(join(dir, "a-validated"));
      const replacement = scenario === "occupied" ? "occupied" :
        scenario === "owner" ? JSON.stringify({ pid: process.pid, nonce: "live-owner" }) : identity;
      if (scenario === "owner") {
        writeFileSync(lock, replacement);
        expect(statSync(lock).ino).toBe(inode);
      } else {
        renameSync(lock, join(dir, "original"));
        writeFileSync(lock, replacement, { flag: "wx", mode: 0o600 });
        expect(statSync(lock).ino).not.toBe(inode);
        if (unreadable) chmodSync(lock, 0o000);
      }
      writeFileSync(join(dir, "resume-a"), "");
      let done = false;
      void exited.then(() => { done = true; });
      const deadline = Date.now() + 8000;
      while (!done && !existsSync(join(dir, "a-writing"))) {
        if (Date.now() > deadline) throw new Error("contender timeout");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(existsSync(join(dir, "a-writing"))).toBe(false);
      expect(await exited).toBe(0);
      const outcome = JSON.parse(output);
      expect(outcome.reason).toBe("busy");
      expect(existsSync(lock)).toBe(true);
      if (unreadable) chmodSync(lock, 0o600);
      expect(readFileSync(lock, "utf8")).toBe(replacement);
      expect(outcome.warnings).toHaveLength(0);
      expect(existsSync(`${lock}.takeover`)).toBe(false);
    } finally {
      writeFileSync(join(dir, "finish"), "");
      writeFileSync(join(dir, "resume-a"), "");
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child!.once("close", () => resolve()));
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
}

for (const scenario of ["live-aged", "dead-recent", "dead-aged", "malformed-aged", "malformed-recent"]) {
  test(`a ${scenario} takeover mutex ${scenario !== "dead-aged" ? "blocks" : "permits"} capture`, async () => {
    const home = mkdtempSync(join(tmpdir(), "flair-takeover-mutex-"));
    const dir = join(home, ".flair", "capture");
    try {
      mkdirSync(dir, { recursive: true });
      const dead = spawn(process.execPath, ["-e", ""], { timeout: 1000 });
      await new Promise<void>((resolve) => dead.once("close", () => resolve()));
      const lock = lockPath(dir, "agent");
      writeFileSync(lock, "{", { flag: "wx", mode: 0o600 });
      const old = new Date(Date.now() - CAPTURE_LOCK_STALE_MS - 1000);
      utimesSync(lock, old, old);
      const mutex = `${lock}.takeover`;
      const identity = scenario.startsWith("malformed-") ? "{" : JSON.stringify({
        pid: scenario === "live-aged" ? process.pid : dead.pid, nonce: "mutex-owner",
      });
      writeFileSync(mutex, identity, { flag: "wx", mode: 0o600 });
      const mutexTime = scenario.endsWith("aged") ? old : new Date(Date.now() - (scenario === "malformed-recent" ? CAPTURE_LOCK_STALE_MS / 2 : 0));
      utimesSync(mutex, mutexTime, mutexTime);
      const outcome = await captureChild(home, dir);
      if (scenario !== "dead-aged") {
        expect(outcome.result.reason).toBe("refused");
        expect(readFileSync(mutex, "utf8")).toBe(identity);
        expect(readFileSync(lock, "utf8")).toBe("{");
        if (scenario.endsWith("aged")) {
          expect(outcome.warnings).toHaveLength(1);
          expect(outcome.warnings[0]).toContain(mutex);
          expect(outcome.warnings[0]).toMatch(/age \d+ ms/);
          expect(outcome.warnings[0]).toContain(scenario.startsWith("malformed") ? "malformed identity" : `holder pid ${process.pid} is alive`);
          expect(outcome.warnings[0]).toContain(`remove ${mutex} if no capture flush is running`);
        } else {
          expect(outcome.warnings).toHaveLength(0);
        }
      } else {
        expect(outcome.result.reason).toBe("appended");
        expect(existsSync(mutex)).toBe(false);
        expect(existsSync(`${mutex}.takeover`)).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
}

for (const kind of ["append", "flush"]) {
  for (const scenario of ["malformed-aged", "live-aged", "malformed-recent"]) {
    test(`a ${scenario} ${kind} takeover mutex reports ${scenario.endsWith("aged") ? "busy-stuck-takeover" : "busy"}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "flair-stuck-takeover-"));
      try {
        const env = { FLAIR_AGENT_ID: "agent" };
        runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-a." }), { dir, env });
        const lock = kind === "append" ? lockPath(dir, "agent") : flushLockPath(dir, "agent");
        const mutex = `${lock}.takeover`;
        const now = Date.now();
        const old = new Date(now - CAPTURE_LOCK_STALE_MS - 1000);
        writeFileSync(lock, "{", { flag: "wx", mode: 0o600 });
        utimesSync(lock, old, old);
        const identity = scenario === "live-aged" ? JSON.stringify({ pid: process.pid, nonce: "live-owner" }) : "{";
        writeFileSync(mutex, identity, { flag: "wx", mode: 0o600 });
        const mutexTime = scenario.endsWith("aged") ? old : new Date(now - CAPTURE_LOCK_STALE_MS / 2);
        utimesSync(mutex, mutexTime, mutexTime);
        const warnings: string[] = [];
        const outcome = await runCaptureFlush({ dir, env, warn: (message) => warnings.push(message),
          makeClient: () => { throw new Error("client must not be created while busy"); },
        });
        expect(outcome).toEqual({ flushed: 0, remaining: 1, reason: scenario.endsWith("aged") ? "busy-stuck-takeover" : "busy" });
        expect(readFileSync(lock, "utf8")).toBe("{");
        expect(readFileSync(mutex, "utf8")).toBe(identity);
        if (scenario.endsWith("aged")) {
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain(mutex);
          const age = Number(warnings[0]!.match(/age (\d+) ms/)?.[1]);
          expect(age).toBeGreaterThanOrEqual(CAPTURE_LOCK_STALE_MS + 1000);
          expect(age).toBeLessThanOrEqual(Date.now() - old.getTime() + 1);
          expect(warnings[0]).toContain(scenario === "live-aged" ? `holder pid ${process.pid} is alive` : "malformed identity");
          expect(warnings[0]).toContain(`remove ${mutex} if no capture flush is running`);
        } else {
          expect(warnings).toEqual([]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test("the flush hook exits 0 with an aged malformed takeover mutex", async () => {
  const home = mkdtempSync(join(tmpdir(), "flair-stuck-hook-"));
  const dir = join(home, ".flair", "capture");
  try {
    const env = { FLAIR_AGENT_ID: "agent", FLAIR_CAPTURE_DIR: dir, HOME: home };
    runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-a." }), { dir, env });
    const lock = flushLockPath(dir, "agent");
    const mutex = `${lock}.takeover`;
    const old = new Date(Date.now() - CAPTURE_LOCK_STALE_MS - 1000);
    for (const path of [lock, mutex]) {
      writeFileSync(path, "{", { flag: "wx", mode: 0o600 });
      utimesSync(path, old, old);
    }
    const child = spawn(process.execPath, [new URL("../src/capture-hook.ts", import.meta.url).pathname, "--flush"], {
      env: { ...process.env, ...env }, timeout: 5000,
    });
    let output = "";
    let warnings = "";
    child.stdout!.on("data", (data) => { output += data; });
    child.stderr!.on("data", (data) => { warnings += data; });
    expect(await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    })).toBe(0);
    expect(output).toBe("");
    expect(warnings.trim().split("\n")).toHaveLength(1);
    expect(warnings).toContain(`remove ${mutex} if no capture flush is running`);
    expect(readFileSync(mutex, "utf8")).toBe("{");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
