import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexWiringPin, decideCodexPinOnly, repinCodexPin, wireCodex } from "../../src/install/clients.ts";
import { withHome } from "../../src/lib/home.ts";
import { FLAIR_MCP_PACKAGE as pkg, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { comparePinVersions } from "../../src/lib/upgrade-status.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const stale = `${pkg}@0.0.1`;
const env = { FLAIR_AGENT_ID: "fixture", FLAIR_URL: "http://127.0.0.1:9" };

function config(command: string, args: string[]): string {
  return `[mcp_servers.flair]\n${command}\nargs = ${JSON.stringify(args)}\n\n[mcp_servers.flair.env]\nFLAIR_AGENT_ID = "fixture"\n`;
}

function fixture(raw: string, check: (path: string) => void): void {
  expect(comparePinVersions("0.0.1", flairCliVersion())).toBe(-1);
  const home = realpathSync(tempDir("flair-2027-operand-"));
  const path = join(home, ".codex/config.toml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  const barrier = process.env.FLAIR_TEST_CRITICAL_BARRIER;
  delete process.env.FLAIR_TEST_CRITICAL_BARRIER;
  try { withHome(home, () => check(path)); }
  finally {
    if (barrier === undefined) delete process.env.FLAIR_TEST_CRITICAL_BARRIER;
    else process.env.FLAIR_TEST_CRITICAL_BARRIER = barrier;
  }
}

const held: Array<[string, string]> = [
  ["another package operand", config('command = "npx"', ["-y", "other-cli", stale])],
  ["another command", config('command = "other-cli"', ["-y", stale])],
  ["missing command", config("# no command", ["-y", stale])],
  ["duplicate command", config('command = "npx"\n\'command\' = "other-cli"', ["-y", stale])],
  ["subtable command", config("# no command", ["-y", stale]) + 'command = "npx"\n'],
  ["unrecognized option", config('command = "npx"', ["--registry", stale, "other-cli"])],
  ["explicit package option", config('command = "npx"', ["-p", "other-cli", stale])],
  ["another operand after separator", config('command = "npx"', ["--", "other-cli", stale])],
];

for (const [label, raw] of held) {
  test(`Codex operand guard reports unknown and holds ${label}`, () => {
    expect(codexWiringPin(raw)).toBe(`${pkg}@unknown`);
    const decision = decideCodexPinOnly(raw, "Codex");
    expect(decision.result.kind).toBe("hold");
    expect(decision.write).toBeUndefined();
  });

  test(`Codex operand guard preserves bytes during pin-only refresh: ${label}`, () => {
    fixture(raw, (path) => {
      expect(repinCodexPin(path, "Codex").kind).toBe("hold");
      expect(readFileSync(path, "utf8")).toBe(raw);
    });
  });

  test(`Codex operand guard preserves bytes during full wiring: ${label}`, () => {
    fixture(raw, (path) => {
      expect(wireCodex(env).message).toContain("holding");
      expect(readFileSync(path, "utf8")).toBe(raw);
    });
  });
}

for (const [command, args] of [
  ['command = "npx"', [stale, "--verbose"]],
  ["'command' = 'npx' # runner", ["--yes", stale, "--verbose"]],
  ['"command" = "npx"', ["-y", "--", stale, "--verbose"]],
] as const) {
  test(`Codex operand guard refreshes a recognized invocation: ${command} ${args[0]}`, () => {
    const raw = config(command, [...args]);
    fixture(raw, (path) => {
      expect(codexWiringPin(raw)).toBe(stale);
      expect(repinCodexPin(path, "Codex").kind).toBe("repinned");
      expect(readFileSync(path, "utf8")).toBe(raw.replace(stale, mcpServerSpec()));
      expect(readFileSync(`${path}.bak`, "utf8")).toBe(raw);
    });
  });
}
