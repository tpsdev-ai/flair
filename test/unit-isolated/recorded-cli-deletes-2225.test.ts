import { beforeEach, afterEach, expect, test, spyOn } from "bun:test";
import { Command } from "commander";
import { harnessState, resetHarnessState, installMemoryHarperMock, databasesMock } from "../helpers/memory-search-harness";
import { bindCli as bindMemory, register as registerMemory, type MemoryCli } from "../../src/commands/memory";
import { bindCli as bindAgent, register as registerAgent, type AgentCli } from "../../src/commands/agent";
process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete process.env.FLAIR_PUBLIC;
installMemoryHarperMock();
const { Memory } = await import("../../resources/Memory.ts");
const originalFetch = globalThis.fetch;
const originalPass = process.env.FLAIR_ADMIN_PASS;
let deletes: string[];
let log: ReturnType<typeof spyOn>;
let write: ReturnType<typeof spyOn>;
const row = { id: "owner-compact-/m", agentId: "owner", durability: "permanent", content: "junk" };
const api = async (method: string, path: string, _body: any, options: any) => {
  expect(method).toBe("DELETE");
  expect(options.agentId).toBeNull();
  expect(options.explicitAdminPass).toBe("secret");
  expect(options.baseUrl).toBe("http://127.0.0.1:19926");
  const id = decodeURIComponent(path.slice("/Memory/".length));
  deletes.push(id);
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true } });
  return r.delete(id);
};
beforeEach(() => {
  resetHarnessState();
  harnessState.memoryStore.set(row.id, { ...row });
  deletes = [];
  process.env.FLAIR_ADMIN_PASS = "secret";
  log = spyOn(console, "log").mockImplementation(() => {});
  write = spyOn(process.stdout, "write").mockImplementation(() => true);
  globalThis.fetch = (async (_url: any, init: any) => {
    const b = JSON.parse(init.body);
    if (b.operation === "delete" && b.table === "Memory") {
      for (const id of b.ids ?? b.hash_values ?? []) harnessState.memoryStore.delete(id);
      return Response.json({ message: "1 of 1 records deleted" });
    }
    return Response.json(b.table === "Memory" ? [...harnessState.memoryStore.values()] : b.table === "Agent" ? [{ id: "owner" }] : []);
  }) as typeof fetch;
  bindMemory({ api, resolveBaseUrl: () => "https://remote.invalid", resolveOpsPort: () => 19925, resolveHttpPort: () => 19926,
    addSharedCredentialOptions: (cmd: Command) => cmd, addSharedIdentityOption: (cmd: Command) => cmd,
    resolveSigningAgentId: () => ({ agentId: null, source: "none" }), applyAdminPassFile: () => {},
    parseEntitiesOptionOrExit: () => [], ENTITIES_OPTION_DESCRIPTION: "entities",
  } satisfies MemoryCli);
  bindAgent({ api, resolveOpsPort: () => 19925, resolveHttpPort: () => 19926,
    b64url: () => "", privKeyPath: () => "", pubKeyPath: () => "",
    shouldShowInlineSecretWarning: () => false, resolveEffectiveOpsUrl: () => undefined,
    seedAgentViaOpsApi: async () => {}, agentRecordIsAdmin: () => false,
  } satisfies AgentCli);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPass === undefined) delete process.env.FLAIR_ADMIN_PASS; else process.env.FLAIR_ADMIN_PASS = originalPass;
  log.mockRestore(); write.mockRestore();
});
async function invoke(kind: "hygiene" | "remove") {
  const cmd = new Command();
  if (kind === "hygiene") registerMemory(cmd); else registerAgent(cmd);
  await cmd.parseAsync(kind === "hygiene" ? ["memory", "hygiene", "--apply"] : ["agent", "remove", "owner", "--force", "--keep-keys"], { from: "user" });
}
async function assertRecorded(kind: "hygiene" | "remove") {
  await invoke(kind);
  expect(deletes).toEqual([row.id]);
  expect(harnessState.memoryStore.has(row.id)).toBe(false);
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
