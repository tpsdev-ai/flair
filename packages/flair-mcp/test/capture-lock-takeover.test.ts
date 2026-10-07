import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPath, runCapture } from "../src/capture-spool.ts";

const CONTENDER = `
const { mock } = await import("bun:test");
const fs = await import("node:fs");
const real = { ...fs };
const { join } = await import("node:path");
const dir = process.env.CAPTURE_TEST_DIR;
const lock = join(dir, "agent.lock");
const cell = new Int32Array(new SharedArrayBuffer(4));
function wait(path) {
  const deadline = Date.now() + 8000;
  while (!real.existsSync(path)) {
    if (Date.now() > deadline) throw new Error("barrier timeout: " + path);
    Atomics.wait(cell, 0, 0, 2);
  }
}
let paused = false;
function beforeMutation(path) {
  if (process.env.CONTENDER === "a" && path === lock && !paused) {
    paused = true;
    real.writeFileSync(join(dir, "a-validated"), "");
    wait(join(dir, "resume-a"));
  }
}
mock.module("node:fs", () => ({ ...real,
  unlinkSync(path) { beforeMutation(path); return real.unlinkSync(path); },
  renameSync(path, target) {
    beforeMutation(path);
    const result = real.renameSync(path, target);
    if (path === lock && process.env.RESTORE_BLOCK === "1") real.writeFileSync(lock, "occupied", { flag: "wx" });
    return result;
  },
}));
const { runCaptureFlush } = await import(process.env.CAPTURE_TEST_MODULE);
const warnings = [];
const result = await runCaptureFlush({ warn: message => warnings.push(message), dir, env: { FLAIR_AGENT_ID: "agent" },
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

test("a delayed dead-lock contender backs off after another contender starts writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flair-takeover-"));
  const children: ReturnType<typeof spawn>[] = [];
  try {
    runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-a." }), {
      dir, env: { FLAIR_AGENT_ID: "agent" },
    });
    const dead = spawn(process.execPath, ["-e", ""], { timeout: 1000 });
    await new Promise<void>((resolve) => dead.once("close", () => resolve()));
    writeFileSync(lockPath(dir, "agent"), JSON.stringify({ pid: dead.pid, nonce: "dead-owner" }), { flag: "wx", mode: 0o600 });
    function contender(name: string) {
      const child = spawn(process.execPath, ["-e", CONTENDER], {
        env: { ...process.env, CONTENDER: name, CAPTURE_TEST_DIR: dir,
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
    const survivor = readFileSync(lockPath(dir, "agent"), "utf8");
    writeFileSync(join(dir, "resume-a"), "");
    let done = false;
    void a.then(() => { done = true; }, () => { done = true; });
    const deadline = Date.now() + 8000;
    while (!done && !existsSync(join(dir, "a-writing"))) {
      if (Date.now() > deadline) throw new Error("contender timeout");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(existsSync(join(dir, "a-writing"))).toBe(false);
    expect(readFileSync(lockPath(dir, "agent"), "utf8")).toBe(survivor);
    writeFileSync(join(dir, "finish"), "");
    expect(JSON.parse(await b).flushed).toBe(1);
    expect(JSON.parse(await a).reason).toBe("busy");
  } finally {
    writeFileSync(join(dir, "finish"), "");
    writeFileSync(join(dir, "resume-a"), "");
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
      new Promise<void>((resolve) => child.once("close", () => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

for (const scenario of ["inode", "owner", "occupied"]) {
  const blocked = scenario === "occupied";
  test(`a changed lock (${scenario}) returns busy and ${blocked ? "stays parked" : "is restored"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-takeover-inode-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: use host-a." }), {
        dir, env: { FLAIR_AGENT_ID: "agent" },
      });
      const dead = spawn(process.execPath, ["-e", ""], { timeout: 1000 });
      await new Promise<void>((resolve) => dead.once("close", () => resolve()));
      const lock = lockPath(dir, "agent");
      const identity = JSON.stringify({ pid: dead.pid, nonce: "dead-owner" });
      writeFileSync(lock, identity, { flag: "wx", mode: 0o600 });
      const inode = statSync(lock).ino;
      child = spawn(process.execPath, ["-e", CONTENDER], {
        env: { ...process.env, CONTENDER: "a", CAPTURE_TEST_DIR: dir, RESTORE_BLOCK: blocked ? "1" : "0",
          CAPTURE_TEST_MODULE: new URL("../src/capture-spool.ts", import.meta.url).pathname },
        timeout: 10_000,
      });
      let output = "";
      child.stdout!.on("data", (data) => { output += data; });
      const exited = new Promise<number | null>((resolve) => child!.once("close", resolve));
      await waitFor(join(dir, "a-validated"));
      const replacement = scenario === "owner" ? JSON.stringify({ pid: process.pid, nonce: "live-owner" }) : identity;
      if (scenario === "owner") {
        writeFileSync(lock, replacement);
        expect(statSync(lock).ino).toBe(inode);
      } else {
        renameSync(lock, join(dir, "original"));
        writeFileSync(lock, replacement, { flag: "wx", mode: 0o600 });
        expect(statSync(lock).ino).not.toBe(inode);
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
      expect(readFileSync(lock, "utf8")).toBe(blocked ? "occupied" : replacement);
      expect(outcome.warnings).toHaveLength(blocked ? 1 : 0);
      if (blocked) {
        const parked = outcome.warnings[0].split("left parked at ")[1];
        expect(readFileSync(parked, "utf8")).toBe(identity);
      }
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
