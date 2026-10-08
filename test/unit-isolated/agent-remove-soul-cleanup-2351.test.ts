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
type SoulRow = { id: string; agentId: string; key: string; value: string; createdAt: string };
type MemoryRow = { id: string; agentId: string; content: string; createdAt: string };
let soulStore: Map<string, SoulRow>;
let memoryStore: Map<string, MemoryRow>;
let memoryScan: (() => Response) | null;
let soulDelete: (() => Response) | null;
let purge: (() => void) | null;
let requested: any[];
let soulScans: number;
let log: ReturnType<typeof spyOn>;
let write: ReturnType<typeof spyOn>;

beforeEach(() => {
  operations = [];
  soulScan = null;
  soulConfirm = null;
  soulDeleteSkips = new Set();
  soulStore = new Map(["soul-a", "soul-b"].map(id => [id, { id, agentId: "owner", key: id, value: "plain", createdAt: new Date().toISOString() }]));
  memoryStore = new Map();
  memoryScan = null;
  soulDelete = null;
  purge = null;
  requested = [];
  soulScans = 0;
  delete process.env.FLAIR_OPS_PORT;
  process.env.FLAIR_ADMIN_PASS = "secret";
  log = spyOn(console, "log").mockImplementation(() => {});
  write = spyOn(process.stdout, "write").mockImplementation(() => true);

  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe("http://127.0.0.1:19925/");
    const b = JSON.parse(init.body);
    requested.push(b);
    operations.push(`${b.operation}:${b.table ?? ""}`);
    if (b.operation === "get_configuration") return Response.json(CONFIGURATION);
    const selected = <T extends { agentId: string }>(rows: T[]) => {
      if (b.operation === "search_by_conditions") {
        expect(b.conditions).toEqual([{ search_attribute: "agentId", search_type: "equals", search_value: b.conditions[0].search_value }]);
        expect(b.get_attributes).toEqual(["id", "agentId"]);
        return rows.filter(row => row.agentId === b.conditions[0].search_value);
      }
      return rows.filter(row => b.search_value.endsWith("*") ? row.agentId.startsWith(b.search_value.slice(0, -1)) : row.agentId === b.search_value);
    };
    if (b.table === "Memory" && b.operation.startsWith("search")) return memoryScan ? memoryScan() : Response.json(selected([...memoryStore.values()]));
    if (b.table === "Agent" && b.operation === "search_by_value") {
      return Response.json([{ id: "owner", name: "Owner" }]);
    }
    if (b.table === "Soul" && b.operation.startsWith("search")) {
      soulScans++;
      if (soulScans === 1) return soulScan ? soulScan() : Response.json(selected([...soulStore.values()]));
      return soulConfirm ? soulConfirm() : Response.json(selected([...soulStore.values()]));
    }
    if (b.table === "Soul" && b.operation === "delete") {
      if (soulDelete) return soulDelete();
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
    api: async (method, path, body) => {
      expect(method).toBe("POST");
      expect(path).toBe("/MemoryPurge");
      const ids = (body as { ids: string[] }).ids;
      for (const id of ids) memoryStore.delete(id);
      purge?.();
      return { removed: ids.length, removedIds: ids };
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

async function invokeAgentRemove(id = "owner"): Promise<void> {
  const cmd = new Command();
  registerAgent(cmd);
  await cmd.parseAsync(["agent", "remove", id, "--force", "--keep-keys"], { from: "user" });
}

test("agent remove deletes the agent's Soul rows, confirms them gone, then deletes the Agent", async () => {
  await invokeAgentRemove();
  expect(operations).toEqual([
    "get_configuration:",
    "search_by_value:Agent",
    "search_by_conditions:Memory",
    "search_by_conditions:Soul",
    "delete:Soul",
    "delete:Soul",
    "search_by_conditions:Soul",
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
  ["a rejected confirmation request", () => { throw new Error("connection closed"); }],
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
  soulDeleteSkips = new Set(["soul-a"]);
  await expect(invokeAgentRemove()).rejects.toThrow(/soul-a/);
  expect(operations.filter((o) => o === "delete:Soul")).toHaveLength(2);
  expect(operations).not.toContain("delete:Agent");
  expect(soulStore.has("soul-a")).toBe(true);
  expect(soulStore.has("soul-b")).toBe(false);
  expect(log.mock.calls.flat().join("\n")).not.toContain("removed successfully");
});

for (const table of ["Memory", "Soul"] as const) {
  test(`agent remove checks every ${table} row owner before deletion`, async () => {
    const rows = [{ id: "owned", agentId: "owner" }, { id: "different", agentId: "other" }];
    if (table === "Memory") memoryScan = () => Response.json(rows);
    else soulScan = () => Response.json(rows);
    let failure: any;
    try { await invokeAgentRemove(); } catch (error) { failure = error; }
    expect(failure?.name).toBe("AgentRemoveOwnerMismatchError");
    expect(failure?.message).toContain(`${table} row 'different'`);
    expect(requested.some(b => b.operation === "delete")).toBe(false);
    expect(soulStore.size).toBe(2);
  });
  test(`agent remove preserves other owners' ${table} rows with a literal agent ID`, async () => {
    const owner = "owner*";
    const other = "owner2";
    soulStore.clear();
    for (const agentId of [owner, other]) {
      for (const suffix of ["a", "b"]) {
        const id = `${agentId}-${suffix}`;
        if (table === "Memory") memoryStore.set(id, { id, agentId, content: "plain", createdAt: new Date().toISOString() });
        else soulStore.set(id, { id, agentId, key: suffix, value: "plain", createdAt: new Date().toISOString() });
      }
    }
    await invokeAgentRemove(owner);
    const rows = table === "Memory" ? [...memoryStore.values()] : [...soulStore.values()];
    expect(rows.map(row => row.id).sort()).toEqual([`${other}-a`, `${other}-b`]);
  });
}

test("agent remove performs Soul confirmation after an empty initial scan and Memory cleanup", async () => {
  soulStore.clear();
  memoryStore.set("memory-a", { id: "memory-a", agentId: "owner", content: "plain", createdAt: new Date().toISOString() });
  purge = () => soulStore.set("soul-later", { id: "soul-later", agentId: "owner", key: "tone", value: "plain", createdAt: new Date().toISOString() });
  await expect(invokeAgentRemove()).rejects.toThrow("soul-later");
  expect(soulScans).toBe(2);
  expect(memoryStore.size).toBe(0);
  expect(soulStore.has("soul-later")).toBe(true);
  expect(operations).not.toContain("delete:Agent");
});

test("agent remove checks row ownership on Soul confirmation", async () => {
  soulConfirm = () => Response.json([{ id: "different", agentId: "other" }]);
  await expect(invokeAgentRemove()).rejects.toMatchObject({ name: "AgentRemoveOwnerMismatchError" });
  expect(operations).not.toContain("delete:Agent");
  expect(requested.filter(b => b.operation === "delete").flatMap(b => b.ids)).not.toContain("different");
});

for (const [label, fail] of [
  ["HTTP failure", () => new Response("unavailable", { status: 500 })],
  ["request rejection", () => { throw new Error("connection closed"); }],
] as const) {
  test(`agent remove names the Soul ID on a per-row delete ${label}`, async () => {
    soulDelete = fail;
    await expect(invokeAgentRemove()).rejects.toThrow("Failed to delete Soul 'soul-a'");
    expect(soulStore.size).toBe(2);
    expect(operations).not.toContain("delete:Agent");
    expect(log.mock.calls.flat().join("\n")).not.toContain("removed successfully");
  });
}
