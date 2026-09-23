/**
 * hook-repin-refused-write-1834.test.ts — flair#1834 PR-H round 4 (CodeRabbit MAJOR).
 *
 * THE DEFECT. `repinSessionStartHook` set `outcome = { action: "update" }` INSIDE
 * decide, BEFORE the write. Its final mapping returned `ok: !refused` — `refused`
 * tracked only PARSE errors — together with `action: outcome.action`. When
 * `atomicReplace` then refused (status "refused", "nothing written: …"), the
 * function returned `ok: true`, action "update", "re-pinned …" for a write that
 * never happened, and `flair doctor --fix` rendered a success (✓) for it.
 *
 * THE FIX. Map `result.status` FIRST. "written" → the recorded update outcome;
 * "noop" → the recorded noop; "held" → the recorded hold/skip (only when decide
 * returned it); "refused" → `ok: false`, action "skip", the primitive's message.
 * A recorded outcome is used only when the status matches what decide returned.
 *
 * RED on 7a86d63e: the refused write reports update/ok ("re-pinned") and the
 * doctor's icon for the hook line is the success icon.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repinSessionStartHook, hookSettingsPath } from "../../src/hook-install.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec, flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";
import { mcpRepinIcon } from "../../src/lib/doctor-run.ts";

const CURRENT_VER = flairCliVersion();
const core = parseSemverCore(CURRENT_VER);
if (!core) throw new Error(`CLI version is not semver: ${CURRENT_VER}`);
const STALE_VER = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;
const CURRENT_SPEC = mcpServerSpec();

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-h-wfail-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

/** The exact Claude Code installer form (`buildSessionStartHookCommand`). */
function claudeCmd(envParts: string, spec: string): string {
  return `sh -c 'out=$(${envParts} npx -y -p ${spec} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

function writeHook(command: string): string {
  const path = hookSettingsPath(isoHome, "claude-code");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n");
  return path;
}

// The primitive's own fixture seam (see codex-toml-atomicity.test.ts T1b): fires
// right after the staging temp exists and before any bytes are written. A throw
// makes atomicReplace REFUSE — a write failure that lands AFTER the decision.
const FAIL_WRITE = {
  afterTempCreate: () => { throw new Error("simulated staged-write failure"); },
};

describe("flair#1834 PR-H round 4 — a refused write after the re-pin decision is a FAILURE", () => {
  it("a canonical stale hook + FAIL_WRITE → ok:false, not update, never 're-pinned', file untouched", () => {
    const path = writeHook(claudeCmd("FLAIR_AGENT_ID=local", STALE_SPEC));
    const before = readFileSync(path, "utf-8");

    const r = repinSessionStartHook(isoHome, "claude-code", FAIL_WRITE);

    expect(readFileSync(path, "utf-8")).toBe(before); // nothing was written
    expect(r.ok).toBe(false);                          // ... the write FAILED
    expect(r.action).not.toBe("update");               // ... never a re-pin
    expect(r.message).not.toContain("re-pinned");      // ... and never says so
    // ... and the doctor's hook line renders as a failure/warning, not ✓.
    expect(mcpRepinIcon(r.action, r.ok)).not.toBe("ok");
    expect(mcpRepinIcon(r.action, r.ok)).toBe("warn");
  });

  it("CONTROL: with the write allowed, the same fixture reports update/ok and advances the pin", () => {
    const path = writeHook(claudeCmd("FLAIR_AGENT_ID=local", STALE_SPEC));

    const r = repinSessionStartHook(isoHome, "claude-code");

    expect(r.ok).toBe(true);
    expect(r.action).toBe("update");
    expect(r.message).toContain("re-pinned");
    expect(mcpRepinIcon(r.action, r.ok)).toBe("ok");
    const after = JSON.parse(readFileSync(path, "utf-8")).hooks.SessionStart[0].hooks[0].command as string;
    expect(after).toBe(claudeCmd("FLAIR_AGENT_ID=local", CURRENT_SPEC));
  });
});
