import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wireCodex } from "../../src/install/clients.ts";
import { readClientMcpBlock } from "../../src/doctor-client.ts";
import { withHome } from "../../src/lib/home.ts";
import { FLAIR_MCP_PACKAGE as pkg, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { mcpClientPinFindings, readOwnedPins } from "../../src/lib/owned-pins.ts";
import { comparePinVersions } from "../../src/lib/upgrade-status.ts";
import { offlineDoctor } from "../helpers/offline-doctor.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const old = `${pkg}@0.0.1`;
const env = { FLAIR_AGENT_ID: "fixture", FLAIR_URL: "http://127.0.0.1:9" };
const forms: Array<[string, (spec: string) => string]> = [
  ["basic", (s) => `args = ["-y", "${s}"]`],
  ["literal", (s) => `args = ['-y', '${s}']`],
  ["mixed", (s) => `args = ["-y", '${s}']`],
  ["multiline basic string", (s) => `args = ["-y", """\n${s}"""]`],
  ["multiline literal string", (s) => `args = ['-y', '''\n${s}''']`],
  ["basic unicode escape", (s) => `args = ["-y", "${s.replace("@", "\\u0040")}"]`],
  ["basic long unicode escape", (s) => `args = ["-y", "${s.replace("@", "\\U00000040")}"]`],
  ["multiline continuation", (s) => `args = ["-y", """${s.replace("/", "/\\\n  ")}"""]`],
  ["multiline array", (s) => `args = [\n  '-y', # install\n  "${s}",\n] # package`],
  ["literal trailing comma and comment", (s) => `args = ['-y', '${s}',] # package`],
  ["quoted key and extra args", (s) => `"args" = ['-y', '${s}', '--verbose']`],
  ["literal key with CRLF", (s) => `'args' = [\r\n '-y', '${s}',\r\n]`],
];

function config(args: string): string {
  return `[mcp_servers.flair]\ncommand = "npx"\n${args}\n\n[mcp_servers.flair.env]\nFLAIR_AGENT_ID = "${env.FLAIR_AGENT_ID}"\nFLAIR_URL = "${env.FLAIR_URL}"\n`;
}

function fixture(raw: string, check: (home: string, path: string) => void): void {
  expect(comparePinVersions("0.0.1", flairCliVersion())).toBe(-1);
  expect(comparePinVersions("9.9.9", flairCliVersion())).toBe(1);
  const home = realpathSync(tempDir("flair-2027-strings-"));
  const path = join(home, ".codex/config.toml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  const barrier = process.env.FLAIR_TEST_CRITICAL_BARRIER;
  delete process.env.FLAIR_TEST_CRITICAL_BARRIER;
  try { withHome(home, () => check(home, path)); }
  finally {
    if (barrier === undefined) delete process.env.FLAIR_TEST_CRITICAL_BARRIER;
    else process.env.FLAIR_TEST_CRITICAL_BARRIER = barrier;
  }
}

for (const [label, args] of forms) {
  test(`B1 wireCodex refreshes ${label} and reports the real pin`, () => {
    const raw = config(args(old));
    fixture(raw, (home, path) => {
      expect(readClientMcpBlock("codex", home).present).toBe(true);
      expect(readOwnedPins(home).find((f) => f.target.id === "codex")?.pin).toBe("0.0.1");
      expect(mcpClientPinFindings(home).find((f) => f.reading.target.id === "codex")?.reading.pin).toBe("0.0.1");
      const result = wireCodex(env);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("refreshed pin");
      expect(readOwnedPins(home).find((f) => f.target.id === "codex")?.pin).toBe(flairCliVersion());
      expect(readFileSync(`${path}.bak`, "utf8")).toBe(raw);
    });
  });

  test(`B1 doctor diagnoses and repairs ${label}`, () => {
    const raw = config(args(old));
    fixture(raw, (home, path) => {
      const doctor = offlineDoctor(home);
      const report = doctor();
      expect(report).toContain("0.0.1");
      expect(report).not.toContain(`${pkg}@unknown`);
      const dry = doctor(["--fix", "--dry-run"]);
      expect(dry).toContain(`(${old} -> ${mcpServerSpec()})`);
      expect(dry).toContain("Would re-pin the MCP server block");
      expect(readFileSync(path, "utf8")).toBe(raw);
      const fixed = doctor(["--fix"]);
      expect(fixed).toContain(`re-pinned Codex (${old} -> ${mcpServerSpec()})`);
      const after = readFileSync(path, "utf8");
      expect((Bun.TOML.parse(after) as any).mcp_servers.flair.args).toContain(mcpServerSpec());
      expect(readClientMcpBlock("codex", home).agentId).toBe(env.FLAIR_AGENT_ID);
      expect(readClientMcpBlock("codex", home).flairUrl).toBe(env.FLAIR_URL);
      expect(readOwnedPins(home).find((f) => f.target.id === "codex")?.pin).toBe(flairCliVersion());
      expect(mcpClientPinFindings(home).some((f) => f.reading.target.id === "codex")).toBe(false);
      expect(readFileSync(`${path}.bak`, "utf8")).toBe(raw);
    });
  }, 90_000);

  for (const pin of ["9.9.9", "latest"]) {
    test(`B1 ${label} holds the real ${pin} pin`, () => {
      const spec = `${pkg}@${pin}`;
      const raw = config(args(spec));
      fixture(raw, (home, path) => {
        expect(readOwnedPins(home).find((f) => f.target.id === "codex")?.pin).toBe(pin);
        expect(mcpClientPinFindings(home).find((f) => f.reading.target.id === "codex")?.reading.pin).toBe(pin);
        const result = wireCodex(env);
        expect(result.message).toContain("holding");
        expect(result.message).toContain(pin);
        expect(result.message).not.toContain("@unknown");
        expect(readFileSync(path, "utf8")).toBe(raw);
        expect(readFileSync(`${path}.bak`, "utf8")).toBe(raw);
      });
    });
  }
}

for (const [label, raw] of [
  ["duplicate args", config(`args = ['-y', '${old}']\nargs = [\"-y\", \"${pkg}@9.9.9\"]`)],
  ["duplicate quoted args", config(`args = ['-y', '${old}']\n'args' = ['${pkg}@9.9.9']`)],
  ["duplicate args after a continued array", config(`args =\n  ['${old}']\nargs = ['${pkg}@9.9.9']`)],
  ["duplicate package", config(`args = ['${old}', '${pkg}@9.9.9']`)],
  ["duplicate header", config(`args = ['${old}']`) + config(`args = ['${pkg}@9.9.9']`)],
  ["fake args inside a note", config(`note = '''\nargs = ['${old}']\n'''`)],
  ["subtable args", config("# no args") + `args = ['${old}']\n`],
  ["escaped quote after a version", config(`args = ["${old}\\\"junk"]`)],
  ["escaped newline after a version", config(`args = ["${old}\\njunk"]`)],
  ["unterminated string", config(`args = ["${old}]`)],
  ["invalid unicode escape", config(`args = ["${pkg}@\\uD800"]`)],
] as const) {
  test(`B1 writer and doctor hold ${label}`, () => {
    fixture(raw, (home, path) => {
      expect(readOwnedPins(home).find((f) => f.target.id === "codex")?.pin).toBe("unknown");
      expect(wireCodex(env).message).toContain("holding");
      const doctor = offlineDoctor(home);
      expect(doctor(["--fix", "--dry-run"])).not.toContain("Would re-pin the MCP server block");
      expect(doctor(["--fix"])).not.toContain("re-pinned Codex");
      expect(readFileSync(path, "utf8")).toBe(raw);
      expect(readFileSync(`${path}.bak`, "utf8")).toBe(raw);
    });
  }, 60_000);
}
