import { beforeEach, afterEach, expect, test, spyOn } from "bun:test";
import { Command } from "commander";
import { harnessState, resetHarnessState, installMemoryHarperMock, databasesMock } from "../helpers/memory-search-harness";
import { bindCli as bindMemory, register as registerMemory, type MemoryCli } from "../../src/commands/memory";
import { bindCli as bindAgent, register as registerAgent, type AgentCli } from "../../src/commands/agent";
process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete process.env.FLAIR_PUBLIC;
installMemoryHarperMock();
const { MemoryPurge } = await import("../../resources/MemoryPurge.ts");
const originalFetch = globalThis.fetch;
const originalPass = process.env.FLAIR_ADMIN_PASS;
const originalOpsPort = process.env.FLAIR_OPS_PORT;
let configuration: unknown;
let opsResolutions: number;
let httpResolutions: number;
let requests: string[];
let otherInstance: Map<string, typeof row>;
let expectedBaseUrl: string;
let deletes: string[];
let operations: string[];
let memoryScan: (() => Response) | null;
let purgeResponse: ((ids: string[]) => unknown) | null;
let log: ReturnType<typeof spyOn>;
let write: ReturnType<typeof spyOn>;
const row = { id: "owner-compact-/m", agentId: "owner", durability: "permanent", content: "junk" };
const api = async (method: string, path: string, body: any, options: any) => {
  expect(method).toBe("POST");
  expect(path).toBe("/MemoryPurge");
  expect(options.agentId).toBeNull();
  expect(options.explicitAdminPass).toBe("secret");
  requests.push(`${method}:${options.baseUrl}`);
  const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
  deletes.push(...ids);
  if (purgeResponse) return purgeResponse(ids);
  if (options.baseUrl === "http://127.0.0.1:29926") {
    for (const id of ids) otherInstance.delete(id);
    return { removed: ids.length };
  }
  expect(options.baseUrl).toBe(expectedBaseUrl);
  const r: any = new (MemoryPurge as any)();
  r.getContext = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true } });
  return r.post({ ids });
};
beforeEach(() => {
  resetHarnessState();
  harnessState.memoryStore.set(row.id, { ...row });
  deletes = [];
  operations = [];
  memoryScan = null;
  purgeResponse = null;
  expectedBaseUrl = "http://127.0.0.1:19926";
  configuration = { http: { port: "127.0.0.1:19926" }, operationsApi: { network: { port: "127.0.0.1:19925" } } };
  opsResolutions = 0;
  httpResolutions = 0;
  requests = [];
  otherInstance = new Map([[row.id, { ...row }]]);
  delete process.env.FLAIR_OPS_PORT;
  process.env.FLAIR_ADMIN_PASS = "secret";
  log = spyOn(console, "log").mockImplementation(() => {});
  write = spyOn(process.stdout, "write").mockImplementation(() => true);
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push(`POST:${url}`);
    expect(String(url)).toBe("http://127.0.0.1:19925/");
    const b = JSON.parse(init.body);
    operations.push(`${b.operation}:${b.table ?? ""}`);
    if (b.operation === "get_configuration") return Response.json(configuration);
    if (memoryScan && b.table === "Memory" && b.operation.startsWith("search")) return memoryScan();
    if (b.operation === "delete" && b.table === "Memory") {
      for (const id of b.ids ?? b.hash_values ?? []) harnessState.memoryStore.delete(id);
      return Response.json({ message: "1 of 1 records deleted" });
    }
    return Response.json(b.table === "Memory" ? [...harnessState.memoryStore.values()] : b.table === "Agent" ? [{ id: "owner" }] : []);
  }) as typeof fetch;
  const resolveOpsPort = (opts: { opsPort?: string | number }) => {
    opsResolutions++;
    return Number(opts.opsPort ?? process.env.FLAIR_OPS_PORT ?? 19925);
  };
  const resolveHttpPort = () => { httpResolutions++; return 29926; };
  bindMemory({ api, resolveBaseUrl: () => "https://remote.invalid", resolveOpsPort, resolveHttpPort,
    addSharedCredentialOptions: (cmd: Command) => cmd, addSharedIdentityOption: (cmd: Command) => cmd,
    resolveSigningAgentId: () => ({ agentId: null, source: "none" }), applyAdminPassFile: () => {},
    parseEntitiesOptionOrExit: () => [], ENTITIES_OPTION_DESCRIPTION: "entities",
  } satisfies MemoryCli);
  bindAgent({ api, resolveOpsPort, resolveHttpPort,
    b64url: () => "", privKeyPath: () => "", pubKeyPath: () => "",
    shouldShowInlineSecretWarning: () => false, resolveEffectiveOpsUrl: () => undefined,
    seedAgentViaOpsApi: async () => {}, agentRecordIsAdmin: () => false,
  } satisfies AgentCli);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPass === undefined) delete process.env.FLAIR_ADMIN_PASS; else process.env.FLAIR_ADMIN_PASS = originalPass;
  if (originalOpsPort === undefined) delete process.env.FLAIR_OPS_PORT; else process.env.FLAIR_OPS_PORT = originalOpsPort;
  log.mockRestore(); write.mockRestore();
});
async function invoke(kind: "hygiene" | "remove", flags: string[] = []) {
  const cmd = new Command();
  if (kind === "hygiene") registerMemory(cmd); else registerAgent(cmd);
  await cmd.parseAsync(kind === "hygiene" ? ["memory", "hygiene", "--apply", ...flags] : ["agent", "remove", "owner", "--force", "--keep-keys", ...flags], { from: "user" });
}
async function assertRecorded(kind: "hygiene" | "remove") {
  await invoke(kind);
  expect(deletes).toEqual([row.id]);
  expect(harnessState.memoryStore.has(row.id)).toBe(false);
  // Positive controls for the refusal tests below: a success logs these and sends the Agent delete.
  expect(log.mock.calls.flat().join("\n")).toContain(kind === "hygiene" ? "Deleted 1 rows" : "removed successfully");
  if (kind === "remove") expect(operations).toContain("delete:Agent");
  expect([...harnessState.deletionStore.values()].map(d => d.memoryId)).toEqual([row.id]);
  harnessState.memoryStore.set(row.id, { ...row });
  const failure = spyOn(databasesMock.flair.MemoryDeletionHistory, "put").mockRejectedValue(new Error("history down"));
  try {
    await expect(invoke(kind)).rejects.toThrow("history down");
    expect(harnessState.memoryStore.has(row.id)).toBe(true);
    expect(harnessState.deletionStore.size).toBe(1);
  } finally { failure.mockRestore(); }
}
test("memory hygiene uses recorded deletes and propagates history failure", () => assertRecorded("hygiene"));
test("agent remove uses recorded deletes and propagates history failure", () => assertRecorded("remove"));

for (const kind of ["hygiene", "remove"] as const) {
  for (const source of ["--ops-port", "FLAIR_OPS_PORT"] as const) {
    test(`${kind}: ${source} scans A and deletes only A while default HTTP selects B`, async () => {
      if (source === "FLAIR_OPS_PORT") process.env.FLAIR_OPS_PORT = "19925";
      await invoke(kind, source === "--ops-port" ? [source, "19925"] : []);
      expect(deletes).toEqual([row.id]);
      expect(otherInstance.has(row.id)).toBe(true);
      expect(requests.filter(r => r.endsWith(":19926"))).toEqual(["POST:http://127.0.0.1:19926"]);
      expect(opsResolutions).toBe(1);
      expect(httpResolutions).toBe(0);
    });
    test(`${kind}: ${source} without a matching HTTP endpoint refuses by name`, async () => {
      configuration = { operationsApi: { network: { port: 19925 } } };
      if (source === "FLAIR_OPS_PORT") process.env.FLAIR_OPS_PORT = "19925";
      await expect(invoke(kind, source === "--ops-port" ? [source, "19925"] : [])).rejects.toThrow(source);
      expect(deletes).toEqual([]);
      expect(otherInstance.has(row.id)).toBe(true);
      expect(requests).toEqual(["POST:http://127.0.0.1:19925/"]);
    });
  }
  test(`${kind}: nonadjacent ports come from the scanned instance configuration`, async () => {
    configuration = { http: { port: 19930 }, operationsApi: { network: { port: 19925 } } };
    expectedBaseUrl = "http://127.0.0.1:19930";
    await invoke(kind, ["--ops-port", "19925"]);
    expect(deletes).toEqual([row.id]);
    expect(otherInstance.has(row.id)).toBe(true);
    expect(opsResolutions).toBe(1);
    expect(httpResolutions).toBe(0);
  });
  for (const config of [null, { http: { port: 19926 } },
    { http: { port: 19926 }, operationsApi: { network: { port: 29925 } } },
    { http: { port: "remote.invalid:19926" }, operationsApi: { network: { port: 19925 } } }]) {
    test(`${kind}: an unpaired configuration refuses before scanning or deletion: ${JSON.stringify(config)}`, async () => {
      configuration = config;
      await expect(invoke(kind, ["--ops-port", "19925"])).rejects.toThrow("--ops-port 19925: no matching local HTTP endpoint");
      expect(requests).toEqual(["POST:http://127.0.0.1:19925/"]);
      expect(otherInstance.has(row.id)).toBe(true);
      expect(deletes).toEqual([]);
    });
  }
  test(`${kind}: an explicit HTTP port from B refuses before scanning or deletion`, async () => {
    await expect(invoke(kind, ["--ops-port", "19925", "--port", "29926"])).rejects.toThrow("--port 29926 does not match --ops-port");
    expect(requests).toEqual(["POST:http://127.0.0.1:19925/"]);
    expect(deletes).toEqual([]);
    expect(otherInstance.has(row.id)).toBe(true);
  });
}

const scanFailures: [string, () => Response][] = [
  ["a failed scan", () => new Response("ops unavailable", { status: 500 })],
  ["a non-array scan", () => Response.json({ results: [] })],
  ["a scan row without an id", () => Response.json([{ agentId: "owner" }])],
];
for (const [label, scan] of scanFailures) {
  test(`agent remove: ${label} stops before any delete and keeps the Agent record`, async () => {
    memoryScan = scan;
    await expect(invoke("remove")).rejects.toThrow("The Memory scan for agent 'owner'");
    expect(deletes).toEqual([]);
    expect(operations).not.toContain("delete:Agent");
    expect(operations).not.toContain("delete:Soul");
    expect(harnessState.memoryStore.has(row.id)).toBe(true);
  });
}

const purgeFailures: [string, (ids: string[]) => unknown][] = [
  ["an empty-body success", () => ({ ok: true })],
  ["a count without the removed ids", (ids) => ({ removed: ids.length })],
  ["a list that leaves out a requested id", () => ({ removed: 0, removedIds: [] })],
  ["a count that disagrees with the list", (ids) => ({ removed: ids.length + 1, removedIds: ids })],
];
for (const [label, respond] of purgeFailures) {
  test(`memory hygiene: ${label} from /MemoryPurge fails the command`, async () => {
    purgeResponse = respond;
    await expect(invoke("hygiene")).rejects.toThrow();
    expect(deletes).toEqual([row.id]);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Deleted");
  });
  test(`agent remove: ${label} from /MemoryPurge fails before the Agent record is deleted`, async () => {
    purgeResponse = respond;
    await expect(invoke("remove")).rejects.toThrow();
    expect(deletes).toEqual([row.id]);
    expect(operations).not.toContain("delete:Agent");
    expect(log.mock.calls.flat().join("\n")).not.toContain("removed successfully");
  });
}
