/**
 * codex-toml-sibling-and-identity-1834.test.ts — flair#1834 PR-A2 round 3.
 *
 * Two CodeRabbit findings OUTSIDE the A2 diff range (they sit in its review
 * body, not as inline threads):
 *
 *  1. The section-boundary matcher was a bare `^\[mcp_servers\.flair` prefix,
 *     so a SIBLING table such as `[mcp_servers.flair2]` was swallowed into the
 *     section. With a real flair section that carries no args, the sibling's
 *     args line became the section's, and a re-pin replaced the SIBLING's pin
 *     and reported a Flair re-pin — a wrong-span write. The matcher now accepts
 *     only the exact header and its dotted subtables, and treats any other
 *     header as the section end.
 *
 *  2. "no identity configured" was a text match, so a commented
 *     `# FLAIR_AGENT_ID = "x"` or an explicit `FLAIR_AGENT_ID = ""` counted as a
 *     configured identity. It is now decided from the ACTIVE, non-empty value.
 *
 * RED on 654e009e: the sibling is re-pinned as if it were the Flair section, and
 * both the commented and empty ids are reported as a configured identity.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as clients from "../../src/install/clients.ts";
import { refreshOwnedPins } from "../../src/lib/owned-pins.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const INSTALLED = flairCliVersion();
const CURRENT_SPEC = mcpServerSpec();
/** The stale version just below a parsed core: decrement the patch; else the
 *  minor (patch 0); else the major (minor and patch 0). Throws on 0.0.0, which
 *  has no stale predecessor. (flair#1834 A2 round 4 — the old inline helper
 *  mapped 1.0.0 to the invalid "1.-1.0".) */
function staleVersion(core: [number, number, number]): string {
  const [major, minor, patch] = core;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error("cannot derive a stale version below 0.0.0");
}

const core = parseSemverCore(INSTALLED);
if (!core) throw new Error(`CLI version is not semver: ${INSTALLED}`);
const STALE_VER = staleVersion(core);
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-a2-r3-"));
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

const REFRESH = () => refreshOwnedPins({ homeDir: isoHome });
const codexResult = () => REFRESH().find((r) => r.target.id === "codex")!;

// ── the sibling table is NOT part of the section ───────────────────────────

describe("T13-codex — a sibling table is not swallowed into the section", () => {
  it("a flair section with no args followed by [mcp_servers.flair2] → HOLD, byte-identical (flair2 untouched)", () => {
    const before = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      ``,
      `[mcp_servers.flair2]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
    ].join("\n");
    const path = writeCodex(before);
    const original = readFileSync(path, "utf-8");

    const r = codexResult();

    expect(r.action).toBe("hold");
    // The file — flair2's args line included — is untouched by the write.
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(readCodex()).toContain(`args = ["-y", "${STALE_SPEC}"]`);
  });

  it("CONTROL: a dotted [mcp_servers.flair.env] subtable still stays inside the section", () => {
    const before = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
      `[mcp_servers.flair.env]`,
      `FLAIR_AGENT_ID = "c"`,
      `FLAIR_URL = "http://remote.invalid:9999"`,
      ``,
    ].join("\n");
    writeCodex(before);

    const r = codexResult();

    expect(r.action).toBe("update");
    expect(readCodex()).toBe(before.replace(STALE_SPEC, CURRENT_SPEC));
    expect(readCodex()).toContain(`[mcp_servers.flair.env]`);
    expect(readCodex()).toContain(`FLAIR_AGENT_ID = "c"`);
  });
});

// ── the fixture's stale-version helper ──────────────────────────────────────

describe("staleVersion — the fixture's stale-version helper", () => {
  it("1.2.3 → decrements the patch", () => {
    expect(staleVersion([1, 2, 3])).toBe("1.2.2");
  });

  it("1.2.0 → falls back to the minor, patch 0", () => {
    expect(staleVersion([1, 2, 0])).toBe("1.1.0");
  });

  it("1.0.0 → falls back to the major, minor and patch 0", () => {
    expect(staleVersion([1, 0, 0])).toBe("0.0.0");
  });

  it("0.0.0 → throws (there is no stale version below it)", () => {
    expect(() => staleVersion([0, 0, 0])).toThrow();
  });
});

// ── "no identity" is the ACTIVE, non-empty value ───────────────────────────

describe("T14-codex — no-identity is decided from the active, non-empty value", () => {
  function withEnvLines(envLines: string[]): string {
    return [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
      `[mcp_servers.flair.env]`,
      ...envLines,
      ``,
    ].join("\n");
  }

  it("a commented `# FLAIR_AGENT_ID = \"x\"` is NOT an identity", () => {
    writeCodex(withEnvLines([`# FLAIR_AGENT_ID = "x"`, `FLAIR_URL = "http://remote.invalid:9999"`]));

    const r = codexResult();

    expect(r.action).toBe("update");
    expect(r.message).toContain("no identity configured");
  });

  it("an EMPTY `FLAIR_AGENT_ID = \"\"` is NOT an identity", () => {
    writeCodex(withEnvLines([`FLAIR_AGENT_ID = ""`]));

    const r = codexResult();

    expect(r.action).toBe("update");
    expect(r.message).toContain("no identity configured");
  });

  it("CONTROL: an active non-empty identity IS an identity (the note is absent)", () => {
    writeCodex(withEnvLines([`FLAIR_AGENT_ID = "c"`]));

    const r = codexResult();

    expect(r.action).toBe("update");
    expect(r.message).not.toContain("no identity configured");
  });
});
