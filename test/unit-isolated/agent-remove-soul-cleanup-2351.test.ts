/**
 * agent-remove-soul-cleanup-2351.test.ts — `flair agent remove` Soul cleanup
 * (flair#2351, mirroring the Memory cleanup of #2299).
 *
 * A Soul scan that fails or returns a malformed response stops the command
 * before any delete. A Soul delete that is not confirmed fails the command, and
 * its message names the Soul ids. The Agent record is deleted only after the
 * agent's Soul rows are confirmed gone.
 *
 * The real `agent remove` command tree runs against a scripted operations
 * endpoint (a fake fetch). The real-Harper case lives in
 * test/integration/local-delete-instance-2225.test.ts.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { bindCli as bindAgent, register as registerAgent, type AgentCli } from "../../src/commands/agent";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

const originalFetch = globalThis.fetch;
const originalPass = process.env.FLAIR_ADMIN_PASS;
const originalOpsPort = process.env.FLAIR_OPS_PORT;

const CONFIGURATION = {
  http: { port: "127.0.0.1:19926" },
  operationsApi: { network: { port: "127.0.0.1:19925" } },
};

let operations: string[];
let soulScan: (() => Response) | null;
let soulConfirm: (() => Response) | null;
let soulDeleteSkips: Set<string>;
let soulStore: Map<string, { id: string }>;
let soulScans: number;
let log: ReturnType<typeof spyOn>;
let write: ReturnType<typeof spyOn>;

beforeEach(() => {
  operations = [];
  soulScan = null;
  soulConfirm = null;
  soulDeleteSkips = new Set();
  soulStore = new Map([["soul-a", { id: "soul-a" }], ["soul-b", { id: "soul-b" }]]);
  soulScans = 0;
  delete process.env.FLAIR_OPS_PORT;
  process.env.FLAIR_ADMIN_PASS = "secret";
  log = spyOn(console, "log").mockImplementation(() => {});
  write = spyOn(process.stdout, "write").mockImplementation(() => true);

  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe("http://127.0.0.1:19925/");
    const b = JSON.parse(init.body);
    operations.push(`${b.operation}:${b.table ?? ""}`);
    if (b.operation === "get_configuration") return Response.json(CONFIGURATION);
    if (b.table === "Memory" && b.operation === "search_by_value") return Response.json([]);
    if (b.table === "Agent" && b.operation === "search_by_value") {
      return Response.json([{ id: "owner", name: "Owner" }]);
    }
    if (b.table === "Soul" && b.operation === "search_by_value") {
      soulScans++;
      if (soulScans === 1) return soulScan ? soulScan() : Response.json([...soulStore.values()]);
      return soulConfirm ? soulConfirm() : Response.json([...soulStore.values()]);
    }
    if (b.table === "Soul" && b.operation === "delete") {
      // Harper queues a delete and can skip it at commit: an id in
      // `soulDeleteSkips` is accepted (200) but left stored.
      for (const id of b.ids ?? []) if (!soulDeleteSkips.has(id)) soulStore.delete(id);
      return Response.json({ message: "1 of 1 records deleted" });
    }
    if (b.table === "Agent" && b.operation === "delete") {
      return Response.json({ message: "1 of 1 records deleted" });
    }
    return Response.json([]);
  }) as typeof fetch;

  const resolveOpsPort = (opts: { opsPort?: string | number }) =>
    Number(opts.opsPort ?? process.env.FLAIR_OPS_PORT ?? 19925);
  const resolveHttpPort = () => 19926;
  bindAgent({
    api: async () => {
      throw new Error("agent remove must not call /MemoryPurge when the agent has no Memory rows");
    },
    resolveOpsPort,
    resolveHttpPort,
    b64url: () => "",
    privKeyPath: () => "",
    pubKeyPath: () => "",
    shouldShowInlineSecretWarning: () => false,
    resolveEffectiveOpsUrl: () => undefined,
    seedAgentViaOpsApi: async () => {},
    agentRecordIsAdmin: () => false,
  } satisfies AgentCli);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
  else process.env.FLAIR_ADMIN_PASS = originalPass;
  if (originalOpsPort === undefined) delete process.env.FLAIR_OPS_PORT;
  else process.env.FLAIR_OPS_PORT = originalOpsPort;
  log.mockRestore();
  write.mockRestore();
});

async function invokeAgentRemove(): Promise<void> {
  const cmd = new Command();
  registerAgent(cmd);
  await cmd.parseAsync(["agent", "remove", "owner", "--force", "--keep-keys"], { from: "user" });
}

test("agent remove deletes the agent's Soul rows, confirms them gone, then deletes the Agent", async () => {
  await invokeAgentRemove();
  expect(operations).toEqual([
    "get_configuration:",
    "search_by_value:Agent",
    "search_by_value:Memory",
    "search_by_value:Soul",
    "delete:Soul",
    "delete:Soul",
    "search_by_value:Soul",
    "delete:Agent",
  ]);
  expect(soulStore.size).toBe(0);
  expect(log.mock.calls.flat().join("\n")).toContain("removed successfully");
});

const scanFailures: [string, () => Response][] = [
  ["a failed scan", () => new Response("ops unavailable", { status: 500 })],
  ["a malformed scan", () => Response.json({ results: [] })],
  ["a scan row without an id", () => Response.json([{ agentId: "owner" }])],
];
for (const [label, scan] of scanFailures) {
  test(`agent remove: ${label} stops before any delete and keeps the Agent and Soul rows`, async () => {
    soulScan = scan;
    await expect(invokeAgentRemove()).rejects.toThrow("The Soul scan for agent 'owner'");
    expect(operations).not.toContain("delete:Soul");
    expect(operations).not.toContain("delete:Agent");
    expect(soulStore.size).toBe(2);
  });
}

const confirmFailures: [string, () => Response][] = [
  ["a failed confirmation scan", () => new Response("ops unavailable", { status: 500 })],
  ["a malformed confirmation scan", () => Response.json({ results: [] })],
];
for (const [label, confirm] of confirmFailures) {
  test(`agent remove: ${label} fails before the Agent delete and names the Soul ids`, async () => {
    soulConfirm = confirm;
    await expect(invokeAgentRemove()).rejects.toThrow(/soul-a, soul-b/);
    expect(operations).toContain("delete:Soul");
    expect(operations).not.toContain("delete:Agent");
    expect(log.mock.calls.flat().join("\n")).not.toContain("removed successfully");
  });
}

test("agent remove: an unconfirmed Soul delete fails before the Agent delete and names the Soul id that remains", async () => {
  // soul-a's delete is accepted but skipped at commit; the confirmation read
  // still finds it. soul-b's delete is confirmed.
  soulDeleteSkips = new Set(["soul-a"]);
  await expect(invokeAgentRemove()).rejects.toThrow(/soul-a/);
  expect(operations.filter((o) => o === "delete:Soul")).toHaveLength(2);
  expect(operations).not.toContain("delete:Agent");
  expect(soulStore.has("soul-a")).toBe(true);
  expect(soulStore.has("soul-b")).toBe(false);
  expect(log.mock.calls.flat().join("\n")).not.toContain("removed successfully");
});
