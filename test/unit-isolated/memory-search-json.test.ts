import { expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/memory.ts";
test.each([false, true])("memory search --json handles wrapped=%s", async (wrapped) => {
  const rows = [{ id: "m1", content: "needle" }];
  const api = mock(async () => wrapped ? { results: rows } : rows);
  bindCli({
    api, resolveBaseUrl: () => "http://unused.invalid",
    resolveSigningAgentId: opts => ({ agentId: opts.agent ?? null, source: "flag" }),
    applyAdminPassFile: () => {}, addSharedCredentialOptions: c => c, addSharedIdentityOption: c => c,
    resolveOpsPort: () => 0, parseEntitiesOptionOrExit: s => s.split(","), ENTITIES_OPTION_DESCRIPTION: "Entities",
  });
  const program = new Command().exitOverride();
  register(program);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(program.parseAsync(["memory", "search", "--json", "--agent", "test", "needle"], { from: "user" })).resolves.toBe(program);
    expect(api).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(rows);
  } finally { log.mockRestore(); }
});
