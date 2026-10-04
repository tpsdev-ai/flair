// The Linux adapter's getconf and /proc I/O is mocked for both readers.
// Module mocks are process-global, so this file runs in the isolated lane.
import { afterAll, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

const stat = "4242 (harper) S 1 4242 4242 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 1 0 24999 100000 2000";
const systemStat = "cpu 1 2 3 4\nbtime 1700000000\nprocesses 2\n";
let tickResult: string | Error = new Error("getconf unavailable");
let getconfCalls = 0;

mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: (command: string, args: string[]) => {
    expect(command).toBe("getconf");
    expect(args).toEqual(["CLK_TCK"]);
    getconfCalls++;
    if (tickResult instanceof Error) throw tickResult;
    return tickResult;
  },
}));
mock.module("node:fs", () => ({
  ...fs,
  readFileSync: (path: string) => {
    if (path === "/proc/4242/stat") return stat;
    if (path === "/proc/stat") return systemStat;
    if (path === "/proc/uptime") return "100.00 200.00\n";
    throw new Error(`unexpected read: ${path}`);
  },
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
afterAll(() => Object.defineProperty(process, "platform", originalPlatform));

const { readProcessStartSecondMs, readProcessStartTimeMs } = await import("../../src/lib/process-start-time.js");

function bothReadersAreUnknown(): void {
  expect(readProcessStartSecondMs(4242)).toBeNull();
  expect(readProcessStartTimeMs(4242)).toBeNull();
}

test("getconf failure leaves both Linux start-time readers unknown", () => {
  tickResult = new Error("getconf unavailable");
  const before = getconfCalls;
  bothReadersAreUnknown();
  expect(getconfCalls - before).toBe(2);
});

test("invalid getconf output leaves both Linux start-time readers unknown", () => {
  const before = getconfCalls;
  for (const invalid of ["0\n", "250x\n", "9007199254740992\n"]) {
    tickResult = invalid;
    bothReadersAreUnknown();
  }
  expect(getconfCalls - before).toBe(6);
});

test("a verified non-100 rate is used by both readers and cached", () => {
  tickResult = "250\n";
  const beforeGetconf = getconfCalls;
  expect(readProcessStartSecondMs(4242)).toBe(1_700_000_099_000);
  const beforeRead = Date.now();
  const fullMs = readProcessStartTimeMs(4242);
  const afterRead = Date.now();
  expect(fullMs).not.toBeNull();
  expect(fullMs!).toBeGreaterThanOrEqual(beforeRead - 4);
  expect(fullMs!).toBeLessThanOrEqual(afterRead - 4);
  expect(getconfCalls - beforeGetconf).toBe(1);
});
