/**
 * codex-pin-only-refresh-1834.test.ts — flair#1834 PR-A2 (Codex TOML).
 *
 * A2 applies A1's invariant to Codex: a pin refresh changes ONLY the source span
 * of the `@tpsdev-ai/flair-mcp` string inside `[mcp_servers.flair]`. Every other
 * byte of config.toml is identical — env tables, other args, other servers,
 * comments, quoting and line endings.
 *
 * On the A1 base these are RED: `repinCodexPin` does not exist yet, and the
 * refresh skips Codex. Written against the module namespace so each test fails
 * on its own assertion rather than failing the file at link time.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as clients from "../../src/install/clients.ts";
import { refreshOwnedPins } from "../../src/lib/owned-pins.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";
import { staleVersion } from "../helpers/stale-version.ts";

const INSTALLED = flairCliVersion();
const CURRENT_SPEC = mcpServerSpec();
const core = parseSemverCore(INSTALLED);
if (!core) throw new Error(`CLI version is not semver: ${INSTALLED}`);
const STALE_VER = staleVersion(core);
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-a2-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function codexPath(): string {
  return clients.clientConfigPath("codex");
}

function writeCodex(text: string): string {
  const p = codexPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function readCodex(): string {
  return readFileSync(codexPath(), "utf-8");
}

/** The builder-emitted section, with a stale pin and extra env keys. */
function codexWith(extra = ""): string {
  return [
    `# top comment mentioning ${FLAIR_MCP_PACKAGE} — outside the section`,
    ``,
    `[mcp_servers.other]`,
    `command = "npx"`,
    `args = ["-y", "some-other-server"]`,
    ``,
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${STALE_SPEC}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "c"`,
    `FLAIR_URL = "http://remote.invalid:9999"`,
    `FLAIR_EXTRA = "keep-me"`,
    extra,
    ``,
  ].join("\n");
}

const REFRESH = () => refreshOwnedPins({ homeDir: isoHome });

// ── T1-codex — byte-identical except the pin span ──────────────────────────

describe("T1-codex — a Codex pin refresh changes only the pin span", () => {
  it("extra env key, an out-of-section comment naming the package, and another server all survive", () => {
    const before = codexWith();
    writeCodex(before);

    const results = REFRESH();

    const after = readCodex();
    // Byte-identical EXCEPT the one pin span.
    expect(after).toBe(before.replace(STALE_SPEC, CURRENT_SPEC));
    expect(after).toContain(`FLAIR_AGENT_ID = "c"`);
    expect(after).toContain(`FLAIR_URL = "http://remote.invalid:9999"`);
    expect(after).toContain(`FLAIR_EXTRA = "keep-me"`);
    expect(after).toContain(`[mcp_servers.other]`);
    expect(after).toContain("some-other-server");
    expect(after).toContain(`# top comment mentioning ${FLAIR_MCP_PACKAGE}`);

    const codex = results.find((r) => r.target.id === "codex")!;
    expect(codex.action).toBe("update");
    expect(codex.message).toContain("re-pinned");
  });
});

// ── T8 — nothing outside the args line steers the guard or the report ──────

describe("T8 — the guard/report key off the args span only", () => {
  it("an unrelated server carrying the package string is not touched", () => {
    const before = [
      `[mcp_servers.other]`,
      `command = "npx"`,
      `args = ["-y", "${FLAIR_MCP_PACKAGE}@1.2.3"]`,
      ``,
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
      `[mcp_servers.flair.env]`,
      `FLAIR_AGENT_ID = "c"`,
      ``,
    ].join("\n");
    writeCodex(before);
    REFRESH();
    const after = readCodex();
    expect(after).toContain(`args = ["-y", "${FLAIR_MCP_PACKAGE}@1.2.3"]`); // untouched
    expect(after).toContain(`args = ["-y", "${CURRENT_SPEC}"]`);
  });

  it("a comment inside the section carrying the current spec does NOT make a behind pin a no-op", () => {
    const before = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `# pinned ${CURRENT_SPEC}`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
      `[mcp_servers.flair.env]`,
      `FLAIR_AGENT_ID = "c"`,
      ``,
    ].join("\n");
    writeCodex(before);
    const results = REFRESH();
    // Visibly held (never a silent no-op); file byte-identical.
    expect(readCodex()).toBe(before);
    expect(results.find((r) => r.target.id === "codex")?.action).toBe("hold");
  });

  it("a fake [mcp_servers.flair] header inside another server's multiline string -> HOLD", () => {
    const before = [
      `[mcp_servers.other]`,
      `note = """`,
      `[mcp_servers.flair]`,
      `"""`,
      ``,
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
    ].join("\n");
    writeCodex(before);
    const results = REFRESH();
    expect(readCodex()).toBe(before);
    expect(results.find((r) => r.target.id === "codex")?.action).toBe("hold");
  });
});

// ── T9-codex — ambiguous shapes are HELD, byte-identical ───────────────────

describe("T9-codex — duplicate/ambiguous TOML shapes are HELD", () => {
  it("a duplicate [mcp_servers.flair] header", () => {
    const before = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
    ].join("\n");
    writeCodex(before);
    const results = REFRESH();
    expect(readCodex()).toBe(before);
    expect(results.find((r) => r.target.id === "codex")?.action).toBe("hold");
  });

  it("a duplicate package occurrence in the section", () => {
    const before = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      `note = "${STALE_SPEC}"`,
      ``,
    ].join("\n");
    writeCodex(before);
    const results = REFRESH();
    expect(readCodex()).toBe(before);
    expect(results.find((r) => r.target.id === "codex")?.action).toBe("hold");
  });

  it("a bare plus a pinned occurrence", () => {
    const before = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      `# bare mention: ${FLAIR_MCP_PACKAGE}`,
      ``,
    ].join("\n");
    writeCodex(before);
    const results = REFRESH();
    expect(readCodex()).toBe(before);
    expect(results.find((r) => r.target.id === "codex")?.action).toBe("hold");
  });
});

// ── T12b-codex — the documented path: extras intact, pin advances ──────────

describe("T12b-codex — a Codex refresh preserves extras and advances the pin", () => {
  it("identity, URL and extra env keys intact; the pin advances", () => {
    const before = codexWith();
    writeCodex(before);
    REFRESH();
    const after = readCodex();
    expect(after).toBe(before.replace(STALE_SPEC, CURRENT_SPEC));
    expect(after).toContain(`FLAIR_AGENT_ID = "c"`);
    expect(after).toContain(`FLAIR_URL = "http://remote.invalid:9999"`);
    expect(after).toContain(`FLAIR_EXTRA = "keep-me"`);
    expect(after).not.toContain(STALE_SPEC);
  });

  it("repinCodexPin is the writer (namespace export present on A2)", () => {
    expect(typeof (clients as any).repinCodexPin).toBe("function");
    expect(typeof (clients as any).decideCodexPinOnly).toBe("function");
  });
});
