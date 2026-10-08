import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { HTTP_PORT, OPS_PORT, runPlain } from "../helpers/init-plain-attribution-fixture.ts";

beforeAll(() => ensureCliBuild(), 120_000);

test("injected matching PID and PID file pass both port gates", () => {
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

test("simulated launchd-style injected PID and PID file pass the HTTP gate with an unused operations port", () => {
  const { result, events, actions } = runPlain("own-launchd");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(true);
  expect(events.some(e => e.kind === "auth" && e.url?.includes(`:${OPS_PORT}/`))).toBe(false);
}, 30_000);

test("a simulated listener whose injected PID differs from the PID file refuses before credentials", () => {
  const { result, events, actions } = runPlain("foreign-launchd");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("attribution to this data directory was not confirmed");
  const refusal = result.stderr.split("\n").find(line => line.startsWith("Refusing init"));
  expect(refusal).toContain(`port ${HTTP_PORT}`);
  expect(refusal).toContain("pid 4243");
  expect(refusal).not.toMatch(/listener|answered|waiting|ownership/);
  expect(refusal?.match(/attribution to this data directory was not confirmed/g)).toHaveLength(1);
  expect(result.stderr).not.toContain("send its admin password to a process it did not start");
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);

test("injected free ports enter the simulated install and run branches", () => {
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

test("an injected null PID result and a simulated connect timeout refuse before start", () => {
  const { result, events, actions } = runPlain("unknown");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain(`port ${HTTP_PORT}: TCP probe was inconclusive`);
  expect(result.stderr).toContain("TCP probe was inconclusive");
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);

test("simulated missing lsof and simulated ECONNREFUSED on both ports reach the simulated install and run before credentials", () => {
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
  test(`simulated missing lsof with ${scenario} refuses before credentials or start`, () => {
    const { result, events, actions } = runPlain(scenario);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Refusing init");
    expect(result.stderr).toContain(`port ${HTTP_PORT}`);
    expect(result.stderr).toContain(scenario === "missing-listener" ? "attribution to this data directory was not confirmed" : "TCP probe was inconclusive");
    expect(actions).toEqual([]);
    expect(events.some(e => e.kind === "auth")).toBe(false);
    expect(events.some(e => e.kind === "closed")).toBe(true);
  }, 30_000);
}


for (const scenario of ["missing-listener", "unknown"] as const) {
  test(`simulated missing lsof with operations port ${scenario} refuses before credentials`, () => {
    const { result, events, actions } = runPlain(scenario, OPS_PORT);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${OPS_PORT}`);
    expect(actions).toEqual([]);
    expect(events.some(e => e.kind === "auth")).toBe(false);
  }, 30_000);
}

test("simulated missing lsof with real refused TCP connections reaches the simulated install and run", () => {
  const { result, actions } = runPlain("missing-real-free");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(actions).toEqual(["install", "run"]);
}, 30_000);

for (const scenario of ["spawned", "child-dead", "other-child", "post-unknown", "root-mismatch", "root-missing", "owner-unknown", "proc-mismatch"] as const) {
  test(`post-start attribution with simulated missing lsof:${scenario}`, () => {
    const { result, events, actions } = runPlain(scenario);
    expect(result.error).toBeUndefined();
    expect(actions).toEqual(["install", "run"]);
    expect(result.status, result.stdout + result.stderr).toBe(scenario === "spawned" ? 0 : 1);
    expect(events.some(e => e.kind === "auth")).toBe(scenario === "spawned");
    if (scenario !== "spawned") expect(result.stderr).toContain("Refusing init");
  }, 30_000);
}

test("a simulated listener reported after the simulated install refuses before spawn or credentials", () => {
  const { result, events, actions } = runPlain("install-race");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(actions).toEqual(["install"]);
  expect(result.stderr).toContain("pre-start port check failed");
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);

test("init polls simulated TCP readiness of the child before sending credentials", () => {
  const { result, events } = runPlain("child-starting");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const firstAuth = events.findIndex(e => e.kind === "auth");
  expect(events.slice(0, firstAuth).filter(e => e.kind === "tcp" && e.port === HTTP_PORT).length).toBeGreaterThanOrEqual(4);
}, 30_000);

for (const scenario of ["lsof-child", "lsof-empty", "lsof-unknown"] as const) {
  test(`simulated macOS-branch child attribution:${scenario}`, () => {
    const { result, events } = runPlain(scenario);
    expect(result.status, result.stdout + result.stderr).toBe(scenario === "lsof-child" ? 0 : 1);
    expect(events.some(e => e.kind === "auth")).toBe(scenario === "lsof-child");
    if (scenario !== "lsof-child") expect(result.stderr).toContain("attribution to this data directory was not confirmed");
  }, 30_000);
}

for (const scenario of ["own-stopped", "own-stopped-real-free"] as const) {
  test(`a simulated instance stops before the credential gate: ${scenario}`, () => {
    const { result, events, actions } = runPlain(scenario);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`port ${HTTP_PORT}(, pid 4242)?: TCP readiness check failed`));
    expect(result.stderr).not.toMatch(/has a listener|occupied|not attributed|attribution to this data directory/);
    expect(actions).toEqual([]);
    expect(events.some(e => e.kind === "auth")).toBe(false);
    const stopped = events.findIndex(e => e.kind === "stopped");
    expect(stopped).toBeGreaterThan(-1);
    expect(events.slice(stopped).some(e => e.kind === "attribution")).toBe(false);
  }, 30_000);
}

test("a rejected injected credential preserves admin-pass bytes", () => {
  const { result, adminPassPath, originalAdminPass, events, actions } = runPlain("own", HTTP_PORT, false);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("injected credential rejection");
  expect(readFileSync(adminPassPath)).toEqual(originalAdminPass);
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);
