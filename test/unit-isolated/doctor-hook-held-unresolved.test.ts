import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSessionStartHookCommand } from "../../src/doctor-client.ts";
import { hookSettingsPath } from "../../src/hook-install.ts";
import { runDoctorChecks } from "../../src/lib/doctor-run.ts";
import * as mcpSpec from "../../src/lib/mcp-spec.ts";
import { tempDir } from "../helpers/temp-dir.ts";

afterEach(() => {
  mcpVersion?.mockRestore();
});

let mcpVersion: ReturnType<typeof spyOn<typeof mcpSpec, "flairCliVersion">> | undefined;

const command = buildSessionStartHookCommand("agent-a");
const spec = mcpSpec.mcpServerSpec();
const shapes = [
  { name: "multiple package spans", commands: [`npx -y -p other@1 other; ${command}`], held: "2 `npx -y -p` spans" },
  { name: "no matching package span", commands: [command.replace("-p ", "")], held: "0 `npx -y -p` spans" },
  { name: "multiple matching hooks", commands: [command, command], held: "2 Flair SessionStart hooks match" },
  { name: "one installer hook", commands: [command], held: null },
];

for (const shape of shapes) {
  it(`unresolved CLI version: ${shape.name}`, () => {
    mcpVersion = spyOn(mcpSpec, "flairCliVersion").mockReturnValue(mcpSpec.UNKNOWN_VERSION);
    const home = tempDir("flair-doctor-held-");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { flair: { command: "npx", args: ["-y", spec], env: { FLAIR_AGENT_ID: "agent-a" } } },
    }));
    const path = hookSettingsPath(home, "claude-code");
    mkdirSync(dirname(path), { recursive: true });
    const bytes = JSON.stringify({ hooks: { SessionStart: [{ hooks: shape.commands.map((command) => ({ type: "command", command })) }] } });
    writeFileSync(path, bytes);
    const check = runDoctorChecks({
      homeDir: home,
      cwd: home,
      detectedClientIds: ["claude-code"],
      launchd: { state: "not-applicable", detail: "not a launchd host" },
    }).results.find((r) => r.id === "session-start-hook");
    expect(check?.status).toBe(shape.held ? "warn" : "pass");
    if (shape.held) expect(check?.detail).toContain(shape.held);
    expect(readFileSync(path, "utf-8")).toBe(bytes);
  });
}
