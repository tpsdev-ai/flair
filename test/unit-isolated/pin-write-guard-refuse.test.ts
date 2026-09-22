import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * flair#1778 slice 2c-i-a2 — fixture (9): when the RUNNING CLI cannot read its
 * own version, the direct writer REFUSES and writes nothing.
 *
 * On main the writer would fall back to the UNPINNED spec (mcp-spec.ts's
 * "version unknown" branch) — replacing a pinned entry with a weaker one. This
 * replaces that fallback (the named intentional change), so the refuse is
 * asserted THROUGH a writer, not only at the decision.
 *
 * `flairCliVersion` is mocked to "unknown" for this file only, before the
 * writers are imported.
 */
mock.module("../../src/lib/mcp-spec.ts", () => ({
  FLAIR_MCP_PACKAGE: "@tpsdev-ai/flair-mcp",
  FLAIR_PACKAGE: "@tpsdev-ai/flair",
  UNKNOWN_VERSION: "unknown",
  resolveFlairCliVersion: () => "unknown",
  flairCliVersion: () => "unknown",
  clearFlairCliVersionCache: () => {},
  isResolvedVersion: (v: string) => !!v && v !== "unknown",
  mcpServerSpec: (v: string = "unknown") =>
    v && v !== "unknown" ? `@tpsdev-ai/flair-mcp@${v}` : "@tpsdev-ai/flair-mcp",
  unpinnedSpecWarning: () => "this CLI cannot read its own version",
}));

const { ALL_CLIENTS, clientConfigPath } = await import("../../src/install/clients.ts");
const { FLAIR_MCP_PACKAGE } = await import("../../src/lib/mcp-spec.ts");

const ENV = { FLAIR_AGENT_ID: "pinbot", FLAIR_URL: "http://127.0.0.1:19926" };

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pin-guard-refuse-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

describe("fixture (9): an unreadable running version refuses, nothing written", () => {
  const jsonClient = ALL_CLIENTS.find((c) => c.kind === "mcp" && c.id !== "codex")!;

  it(`${jsonClient.label}: a pinned entry is left byte-identical (no unpinned fallback)`, () => {
    const path = clientConfigPath(jsonClient.id as any);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
      mcpServers: { flair: { command: "npx", args: ["-y", `${FLAIR_MCP_PACKAGE}@0.0.1`], env: { ...ENV } } },
    }, null, 2) + "\n");
    const before = readFileSync(path, "utf-8");

    const res = jsonClient.wire({ ...ENV, FLAIR_CLIENT: jsonClient.id });

    expect(res.message).toContain("REFUSING");
    expect(readFileSync(path, "utf-8")).toBe(before); // nothing written
  });
});
