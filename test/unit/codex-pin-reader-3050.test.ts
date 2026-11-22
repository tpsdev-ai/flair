import { expect, it } from "bun:test";
import { repinCodexPin } from "../../src/install/clients.ts";

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function read(raw: string) {
  const path = join(tempDir("flair-pin-reader-"), "config.toml");
  writeFileSync(path, raw);
  const result = repinCodexPin(path, "Codex");
  expect(readFileSync(path, "utf8")).toBe(raw.replace("@tpsdev-ai/flair-mcp@0.1.0", mcpServerSpec()));
  return result;
}

const head = '[mcp_servers.flair]\ncommand = "npx"\nargs = ["-y", "@tpsdev-ai/flair-mcp@0.1.0"]\n';
for (const body of [
  '[mcp_servers.flair.env]\nFLAIR_AGENT_ID = "agent-a"\nFLAIR_AGENT_ID = ""\n',
  '[mcp_servers.flair.env]\nFLAIR_AGENT_ID = "agent-a"junk\n',
  'env = { FLAIR_AGENT_ID = agent-a junk }\n',
  'env = { FLAIR_AGENT_ID = 123 }\n',
  'env = { FLAIR_AGENT_ID = "agent-a" junk }\n',
]) {
  it(`pin reader reports unknown identity for ${JSON.stringify(body)}`, () => {
    const result = read(head + body);
    expect(result.kind).toBe("repinned");
    expect(result.noIdentity).toBe(true);
  });
}
it("pin reader retains identity after an indented array value", () => {
  const raw = head + 'data = [\n  ["one", "two"]\n]\nenv = { FLAIR_AGENT_ID = "agent-a" }\n';
  expect((Bun.TOML.parse(raw) as any).mcp_servers.flair.env.FLAIR_AGENT_ID).toBe("agent-a");
  expect(read(raw).noIdentity).toBe(false);
});
