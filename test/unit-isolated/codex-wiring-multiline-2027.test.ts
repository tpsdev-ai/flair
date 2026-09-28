import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clientConfigPath, wireCodex } from "../../src/install/clients.ts";
import { withHome } from "../../src/lib/home.ts";
import {
  FLAIR_MCP_PACKAGE,
  flairCliVersion,
  mcpServerSpec,
} from "../../src/lib/mcp-spec.ts";
import { comparePinVersions } from "../../src/lib/upgrade-status.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const STALE_VERSION = "0.0.1";
const AHEAD_VERSION = "9.9.9";
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VERSION}`;
const CURRENT_SPEC = mcpServerSpec();
const env = {
  FLAIR_AGENT_ID: "round-two",
  FLAIR_URL: "http://127.0.0.1:19926",
};

function block(spec: string): string {
  return [
    "[mcp_servers.flair]",
    'command = "npx"',
    `args = ["-y", "${spec}"]`,
    "",
    "[mcp_servers.flair.env]",
    `FLAIR_AGENT_ID = "${env.FLAIR_AGENT_ID}"`,
    `FLAIR_URL = "${env.FLAIR_URL}"`,
    "",
  ].join("\n");
}

function withConfig(raw: string, check: (path: string) => void): void {
  // These must be real stale/ahead fixtures; version/setup failures fail loudly.
  expect(comparePinVersions(STALE_VERSION, flairCliVersion())).toBe(-1);
  expect(comparePinVersions(AHEAD_VERSION, flairCliVersion())).toBe(1);
  const home = realpathSync(tempDir("flair-2027-codex-"));
  const path = join(home, ".codex", "config.toml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, "utf8");
  const previousBarrier = process.env.FLAIR_TEST_CRITICAL_BARRIER;
  delete process.env.FLAIR_TEST_CRITICAL_BARRIER;
  try {
    withHome(home, () => {
      expect(clientConfigPath("codex")).toBe(path);
      check(path);
    });
  } finally {
    if (previousBarrier === undefined) {
      delete process.env.FLAIR_TEST_CRITICAL_BARRIER;
    } else {
      process.env.FLAIR_TEST_CRITICAL_BARRIER = previousBarrier;
    }
  }
}

function expectRefresh(before: string): void {
  withConfig(before, (path) => {
    const result = wireCodex(env);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("refreshed pin");
    expect(readFileSync(path, "utf8")).toBe(before.replace(STALE_SPEC, CURRENT_SPEC));
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(before);
  });
}

function expectHold(before: string): void {
  withConfig(before, (path) => {
    const result = wireCodex(env);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("holding");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
}

for (const quote of ['"', "'"]) {
  const fence = quote.repeat(3);
  const later = [
    "",
    "[other.tool]",
    `note = ${fence}`,
    "unrelated multiline text",
    fence,
    "",
  ].join("\n");

  test(`wireCodex refreshes a stale pin before a later ${fence} string`, () => {
    expectRefresh(block(STALE_SPEC) + later);
  });

  test(`wireCodex refreshes after a closed earlier ${fence} string`, () => {
    const earlier = [
      "[other.tool]",
      `note = ${fence}`,
      "unrelated multiline text",
      fence,
      "",
      "",
    ].join("\n");
    expectRefresh(earlier + block(STALE_SPEC));
  });

  test(`wireCodex recognizes the current pin before a later ${fence} string`, () => {
    const before = block(CURRENT_SPEC) + later;
    withConfig(before, (path) => {
      const result = wireCodex(env);
      expect(result).toEqual({
        ok: true,
        message: "Codex: already wired in ~/.codex/config.toml",
      });
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  test(`wireCodex holds a fake header inside an earlier ${fence} string`, () => {
    // The closing fence is beyond a fake unrelated header, outside the
    // candidate Flair section. Only the before-header check sees the opening.
    const before = [
      "[other.tool]",
      `note = ${fence}`,
      block(STALE_SPEC),
      "[other.tail]",
      fence,
      "",
    ].join("\n");
    expectHold(before);
  });

  test(`wireCodex holds a ${fence} string in the Flair table`, () => {
    const before = block(STALE_SPEC).replace(
      "[mcp_servers.flair.env]",
      `note = ${fence}\nkeep this text\n${fence}\n[mcp_servers.flair.env]`,
    );
    expectHold(before);
  });

  test(`wireCodex holds a ${fence} string in a Flair subtable`, () => {
    const before = block(STALE_SPEC) + `note = ${fence}\nkeep this text\n${fence}\n`;
    expectHold(before);
  });

  for (const version of [AHEAD_VERSION, "unknown"]) {
    test(`wireCodex holds ${version} before a later ${fence} string`, () => {
      expectHold(block(`${FLAIR_MCP_PACKAGE}@${version}`) + later);
    });
  }
}
