import { expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { withHome } from "../../src/lib/home.ts";
import { FLAIR_MCP_PACKAGE as pkg, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
const wiring = await import("../../src/lib/wiring-spec.ts");
const decode = wiring.decodeWiringSpec;
const seen: string[] = [];
mock.module("../../src/lib/wiring-spec.ts", () => ({
  ...wiring,
  decodeWiringSpec: (text: string, name: string) => { seen.push(text); return decode(text, name); },
}));
const { wireClaudeCodeJson, wireCodex } = await import("../../src/install/clients.ts");
const { fixContinuityCaptureHooks, upgradeSessionStartHookCommand } = await import("../../src/doctor-client.ts");
const { repinSessionStartHookGuarded } = await import("../../src/lib/owned-pins.ts");
delete process.env.FLAIR_TEST_CRITICAL_BARRIER;
for (const [kind, version] of ["json", "codex", "continuity", "hook", "legacy"].flatMap((kind) =>
  (kind === "legacy" ? [""] : ["0.0.1", "9.9.9", "unknown"]).map((version) => [kind, version]))) {
  test(`${kind}: guard input and write outcome ${version}`, () => {
    const root = realpathSync(tempDir("flair-1848-"));
    withHome(root, () => {
      const spec = version ? `${pkg}@${version}` : pkg;
      const command = kind === "legacy" ? `FLAIR_AGENT_ID=old npx -y ${pkg} flair-session-start`
        : kind === "continuity" ? `sh -c 'FLAIR_AGENT_ID=old npx -y -p ${spec} flair-continuity-capture >/dev/null 2>/dev/null || true'`
        : `FLAIR_AGENT_ID=old npx -y -p ${spec} flair-session-start`;
      const path = join(root, kind === "json" ? ".claude.json" : kind === "codex" ? ".codex/config.toml" : ".claude/settings.json");
      const raw = kind === "json" ? JSON.stringify({ mcpServers: { flair: { command: "npx", args: ["-y", spec] } } })
        : kind === "codex" ? `[mcp_servers.flair]\ncommand = "npx"\nargs = ["-y", "${spec}"]\n`
        : JSON.stringify({ hooks: { [kind === "continuity" ? "Stop" : "SessionStart"]: [{ hooks: [{ type: "command", command }] }] } });
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw); seen.length = 0;
      const env = { FLAIR_AGENT_ID: "new", FLAIR_URL: "http://127.0.0.1:19926" };
      if (kind === "json") expect(wireClaudeCodeJson(env).kind).toBe(version === "0.0.1" ? "written" : "held");
      else if (kind === "codex") expect(wireCodex(env).ok).toBe(true);
      else if (kind === "continuity") expect(fixContinuityCaptureHooks(root, "new").ok).toBe(true);
      else if (kind === "hook") expect(repinSessionStartHookGuarded(root, "claude-code").ok).toBe(true);
      else expect(upgradeSessionStartHookCommand(root).changed).toBe(true);
      expect(seen.filter(Boolean).length).toBeGreaterThan(0);
      expect(seen.filter(Boolean).every((text) => text === spec)).toBe(true);
      const after = readFileSync(path, "utf8");
      if (version === "9.9.9" || version === "unknown") expect(after).toBe(raw);
      else { expect(after).not.toBe(raw); expect(after).toContain(kind === "continuity" ? spec : mcpServerSpec()); }
    });
  });
}
