import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarperInstance, StartHarperOptions } from "../helpers/harper-lifecycle.js";

let instance: HarperInstance;
const start = mock(async (_opts: StartHarperOptions) => instance);
const stop = mock(async (_inst: HarperInstance) => {});
mock.module("../helpers/harper-lifecycle.js", () => ({ startHarper: start, stopHarper: stop }));
const { isReplicatedPairReady, probeReplicationSupport, waitUntil } = await import("../helpers/replicated-nodes.js");
let request: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  start.mockClear();
  stop.mockClear();
  instance = {
    httpURL: "http://127.0.0.1:43210",
    opsURL: "http://127.0.0.1:43211",
    installDir: join(tmpdir(), "flair-test-owned"),
    process: null,
    admin: { username: "test-admin", password: "test-password" },
    external: false,
    ownsInstallDir: true,
    getLog: () => "",
  };
  request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
});
afterEach(() => mock.restore());

for (const [label, change] of [
  ["external", { external: true }],
  ["non-loopback", { opsURL: "https://node-a.flair.test:43211" }],
  ["production port", { opsURL: "http://127.0.0.1:9925" }],
  ["non-test directory", { installDir: join(tmpdir(), "unowned") }],
] as const) {
  test(`probe refuses ${label} before any configuration write`, async () => {
    Object.assign(instance, change);
    const result = await probeReplicationSupport();
    expect(result.supported).toBe(false);
    expect(result.error).toContain("probe:");
    expect(request).not.toHaveBeenCalled();
    expect(start.mock.calls[0]![0].multiWorkerUnsafe).toBe(false);
    expect(existsSync(start.mock.calls[0]![0].cwd!)).toBe(false);
  });
}

test("owned probe sends the replicated configuration operation", async () => {
  expect(await probeReplicationSupport()).toEqual({ supported: true, error: null });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0]!;
  expect(url).toBe(instance.opsURL);
  expect(JSON.parse(init!.body as string)).toEqual({
    operation: "set_configuration", replicated: true,
  });
  expect(stop).toHaveBeenCalledWith(instance);
});

const expectedPeers = ["host-b", "host-a"] as const;
function connectedStatuses() {
  return expectedPeers.map((name) => ({
    status: 200,
    body: JSON.stringify({ connections: [{ name, database_sockets: [{ connected: true }, { connected: true }] }] }),
  }));
}

test("a fully connected pair with the expected peers is ready", () => {
  expect(isReplicatedPairReady(connectedStatuses(), expectedPeers)).toBe(true);
});

for (const index of [0, 1]) {
  for (const [label, connection] of [
    ["empty sockets", { database_sockets: [] }],
    ["missing sockets", {}],
    ["disconnected socket", { database_sockets: [{ connected: true }, { connected: false }] }],
    ["missing connected flag", { database_sockets: [{ connected: true }, {}] }],
    ["unexpected peer", { name: "host-other", database_sockets: [{ connected: true }] }],
    ["missing peer name", { name: undefined, database_sockets: [{ connected: true }] }],
  ] as const) {
    test(`node ${index}: ${label} is not ready`, () => {
      const statuses = connectedStatuses();
      statuses[index]!.body = JSON.stringify({ connections: [{ name: expectedPeers[index], ...connection }] });
      expect(isReplicatedPairReady(statuses, expectedPeers)).toBe(false);
    });
  }

  for (const [label, status] of [
    ["missing connections", { status: 200, body: "{}" }],
    ["empty connections", { status: 200, body: '{"connections":[]}' }],
    ["failed status request", { status: 503, body: "{}" }],
  ] as const) {
    test(`node ${index}: ${label} is not ready`, () => {
      const statuses = connectedStatuses();
      statuses[index] = status;
      expect(isReplicatedPairReady(statuses, expectedPeers)).toBe(false);
    });
  }
}

test("a missing node status is not ready", () => {
  expect(isReplicatedPairReady(connectedStatuses().slice(0, 1), expectedPeers)).toBe(false);
});

test("polling measures from the supplied mint timestamp", async () => {
  spyOn(Date, "now").mockReturnValue(1500);
  expect(await waitUntil(() => true, { startMs: 1000, timeoutMs: 1000, what: "peer" })).toBe(500);
});

test("a peer response after the mint deadline is refused", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1500);
  await expect(waitUntil(() => {
    now.mockReturnValue(2001);
    return true;
  }, { startMs: 1000, timeoutMs: 1000, what: "peer" })).rejects.toThrow("peer did not become true");
});
