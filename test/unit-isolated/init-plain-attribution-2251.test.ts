import { beforeAll, expect, test } from "bun:test";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { HTTP_PORT, OPS_PORT, runPlain } from "../helpers/init-plain-attribution-fixture.ts";

beforeAll(() => ensureCliBuild(), 120_000);

test("re-init on this data directory's own adopted instance succeeds and attributes both ports", () => {
  const { result, events } = runPlain("own");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  const probes = events.filter(e => e.kind === "probe").map(e => e.port);
  expect(probes).toContain(HTTP_PORT);
  expect(probes).toContain(OPS_PORT);
  // The operations port is probed before the first credential is sent.
  const firstAuth = events.findIndex(e => e.kind === "auth");
  const opsProbe = events.findIndex(e => e.kind === "probe" && e.port === OPS_PORT);
  expect(firstAuth).toBeGreaterThan(opsProbe);
}, 30_000);

test("flair#1693: re-init accepts the own launchd PID with unreadable ROOTPATH and an unused operations port", () => {
  const { result, events, actions } = runPlain("own-launchd");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(true);
  expect(events.some(e => e.kind === "auth" && e.url?.includes(`:${OPS_PORT}/`))).toBe(false);
}, 30_000);

test("a listener differing from the own launchd PID refuses before credentials", () => {
  const { result, events, actions } = runPlain("foreign-launchd");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("not attributed to this data directory");
  const refusal = result.stderr.split("\n").find(line => line.startsWith("Refusing init"));
  expect(refusal).toContain(`port ${HTTP_PORT}`);
  expect(refusal).toContain("answered /health with HTTP 200");
  expect(refusal).toContain("/.flair/data");
  expect(refusal?.match(/not attributed to this data directory/g)).toHaveLength(1);
  expect(result.stderr).not.toContain("send its admin password to a process it did not start");
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);

test("the from-scratch flow with just-released ports still succeeds and probes first", () => {
  const { result, events, actions } = runPlain("free");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  expect(actions).toEqual(["install", "run"]);
  const probes = events.filter(e => e.kind === "probe").map(e => e.port);
  expect(probes).toContain(HTTP_PORT);
  expect(probes).toContain(OPS_PORT);
  const firstAuth = events.findIndex(e => e.kind === "auth");
  const opsProbe = events.findIndex(e => e.kind === "probe" && e.port === OPS_PORT);
  expect(firstAuth).toBeGreaterThan(opsProbe);
}, 30_000);

test("a failed lsof probe and connect timeout remain unknown: init refuses and starts nothing", () => {
  const { result, events, actions } = runPlain("unknown");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain(`could not read the listener on port ${HTTP_PORT}`);
  expect(result.stderr).toContain("unknown");
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);

test("missing lsof with ECONNREFUSED on both ports installs and starts before sending credentials", () => {
  const { result, events, actions } = runPlain("missing-free");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  expect(actions).toEqual(["install", "run"]);
  expect(events.filter(e => e.kind === "tcp").slice(0, 2)).toEqual([
    { kind: "tcp", port: HTTP_PORT, host: "127.0.0.1" },
    { kind: "tcp", port: OPS_PORT, host: "127.0.0.1" },
  ]);
  expect(events.findIndex(e => e.kind === "auth")).toBeGreaterThan(events.findIndex(e => e.kind === "closed" && e.port === OPS_PORT));
}, 30_000);

for (const scenario of ["missing-listener", "missing-error"] as const) {
  test(`missing lsof with ${scenario} refuses before credentials or start`, () => {
    const { result, events, actions } = runPlain(scenario);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Refusing init");
    expect(result.stderr).toContain(`port ${HTTP_PORT}`);
    expect(result.stderr).toContain(scenario === "missing-listener" ? "not attributed" : "unknown");
    expect(actions).toEqual([]);
    expect(events.some(e => e.kind === "auth")).toBe(false);
    expect(events.some(e => e.kind === "closed")).toBe(true);
  }, 30_000);
}


for (const scenario of ["missing-listener", "unknown"] as const) {
  test(`missing lsof with operations port ${scenario} refuses before credentials`, () => {
    const { result, events, actions } = runPlain(scenario, OPS_PORT);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${OPS_PORT}`);
    expect(actions).toEqual([]);
    expect(events.some(e => e.kind === "auth")).toBe(false);
  }, 30_000);
}

test("missing lsof with real refused TCP connections still initializes", () => {
  const { result, actions } = runPlain("missing-real-free");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(actions).toEqual(["install", "run"]);
}, 30_000);

for (const scenario of ["spawned", "child-dead", "other-child", "post-unknown", "root-mismatch", "root-missing", "owner-unknown", "proc-mismatch"] as const) {
  test(`post-start attribution with missing lsof: ${scenario}`, () => {
    const { result, events, actions } = runPlain(scenario);
    expect(result.error).toBeUndefined();
    expect(actions).toEqual(["install", "run"]);
    expect(result.status, result.stdout + result.stderr).toBe(scenario === "spawned" ? 0 : 1);
    expect(events.some(e => e.kind === "auth")).toBe(scenario === "spawned");
    if (scenario !== "spawned") expect(result.stderr).toContain("Refusing init");
  }, 30_000);
}

test("a listener appearing during install refuses before spawn or credentials", () => {
  const { result, events, actions } = runPlain("install-race");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(actions).toEqual(["install"]);
  expect(result.stderr).toContain("no longer free");
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);

test("init waits for the child listener before sending credentials", () => {
  const { result, events } = runPlain("child-starting");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const firstAuth = events.findIndex(e => e.kind === "auth");
  expect(events.slice(0, firstAuth).filter(e => e.kind === "tcp" && e.port === HTTP_PORT).length).toBeGreaterThanOrEqual(4);
}, 30_000);

for (const scenario of ["lsof-child", "lsof-empty", "lsof-unknown"] as const) {
  test(`macOS child attribution: ${scenario}`, () => {
    const { result, events } = runPlain(scenario);
    expect(result.status, result.stdout + result.stderr).toBe(scenario === "lsof-child" ? 0 : 1);
    expect(events.some(e => e.kind === "auth")).toBe(scenario === "lsof-child");
    if (scenario !== "lsof-child") expect(result.stderr).toContain("not attributed");
  }, 30_000);
}
