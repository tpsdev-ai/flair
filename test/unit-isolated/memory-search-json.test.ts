import { expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/memory.ts";
import * as render from "../../src/render.ts";

// flair#1717: `memory search --json` prints exactly what `flair search --json` prints:
// render.asJSON of the result array, once, for empty and non-empty results, whether the
// server answers with a bare array or a { results } wrapper.
const cases = [
  { name: "non-empty, bare array", rows: [{ id: "m1", content: "needle" }], wrapped: false },
  { name: "non-empty, wrapped", rows: [{ id: "m1", content: "needle" }], wrapped: true },
  { name: "empty, bare array", rows: [], wrapped: false },
  { name: "empty, wrapped", rows: [], wrapped: true },
];

test.each(cases)("memory search --json prints render.asJSON(rows) once: $name", async ({ rows, wrapped }) => {
  const api = mock(async () => (wrapped ? { results: rows } : rows));
  bindCli({
    api, resolveBaseUrl: () => "http://unused.invalid",
    resolveSigningAgentId: (opts) => ({ agentId: opts.agent ?? null, source: "flag" }),
    applyAdminPassFile: () => {}, addSharedCredentialOptions: (c) => c, addSharedIdentityOption: (c) => c,
    resolveOpsPort: () => 0, resolveHttpPort: () => 0, parseEntitiesOptionOrExit: (s) => s.split(","), ENTITIES_OPTION_DESCRIPTION: "Entities",
  });
  const program = new Command().exitOverride();
  register(program);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(program.parseAsync(["memory", "search", "--json", "--agent", "test", "needle"], { from: "user" })).resolves.toBe(program);
    expect(api).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.length).toBe(1);
    expect(log.mock.calls[0][0]).toBe(render.asJSON(rows));
  } finally {
    log.mockRestore();
  }
});
