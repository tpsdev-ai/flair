/**
 * codex-toml-multiline-fence-1834.test.ts — flair#1834 PR-A2 round 4.
 *
 * CodeRabbit finding (thread on clients.ts:781): the editor's multiline-string
 * fence check looked only BEFORE the `[mcp_servers.flair]` header, and only for
 * an UNMATCHED fence. A `"""` / `'''` string that opens AND closes INSIDE the
 * section can carry a line that looks like a flair sub-table header followed by
 * an `args` line; the section scan accepted the fake sub-table as part of the
 * section and the args match then rewrote the STRING's content — a wrong-span
 * write, when the real `[mcp_servers.flair]` section carries no package arg.
 *
 * The editor now HOLDs on ANY `"""` / `'''` occurrence between the flair header
 * and the section end (the reason names the fence; nothing is written). The
 * before-header unmatched-fence rule is unchanged.
 *
 * RED on d9634ec2: for each fence type, the fake args line inside the string is
 * rewritten to the current pin and the run reports a re-pin.
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
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-a2-r4-"));
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

const codexResult = () => refreshOwnedPins({ homeDir: isoHome }).find((r) => r.target.id === "codex")!;

// ── a multiline string inside the section is never scanned as TOML ──────────

describe("T15-codex — a multiline string inside the section is a HOLD", () => {
  // The real flair section carries NO args; the only args line lives inside a
  // multiline string, after a line that looks like a flair sub-table header.
  function sectionWithFence(fence: string): string {
    return [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `note = ${fence}`,
      `[mcp_servers.flair.env]`,
      `args = ["-y", "${STALE_SPEC}"]`,
      fence,
      ``,
    ].join("\n");
  }

  it('a `"""` string that opens and closes inside the section → HOLD, byte-identical', () => {
    const before = sectionWithFence('"""');
    const path = writeCodex(before);
    const original = readFileSync(path, "utf-8");

    const r = codexResult();

    expect(r.action).toBe("hold");
    expect(r.message).toContain('"""');
    // Nothing written — not the fake args line inside the string, not anything.
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(readCodex()).toContain(`args = ["-y", "${STALE_SPEC}"]`);
  });

  it("a `'''` string that opens and closes inside the section → HOLD, byte-identical", () => {
    const before = sectionWithFence("'''");
    const path = writeCodex(before);
    const original = readFileSync(path, "utf-8");

    const r = codexResult();

    expect(r.action).toBe("hold");
    expect(r.message).toContain("'''");
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(readCodex()).toContain(`args = ["-y", "${STALE_SPEC}"]`);
  });
});

// ── a fence AFTER the section is irrelevant to this section ─────────────────

describe("T15-codex CONTROL — a multiline string in a later table does not block the re-pin", () => {
  it("a later unrelated table with a multiline string → the stale pin still re-pins, only the package span changes", () => {
    const before = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${STALE_SPEC}"]`,
      ``,
      `[other.tool]`,
      `note = """`,
      `just text`,
      `"""`,
      ``,
    ].join("\n");
    writeCodex(before);

    const r = codexResult();

    expect(r.action).toBe("update");
    // Only the package span changed: the fence, the later table and every other
    // byte are identical, so the whole file equals the one-span substitution.
    expect(readCodex()).toBe(before.replace(STALE_SPEC, CURRENT_SPEC));
    expect(readCodex()).toContain(`[other.tool]`);
    expect(readCodex()).toContain(`note = """`);
    expect(readCodex()).toContain(`just text`);
  });
});
