import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  repinSessionStartHook,
  hookSettingsPath,
} from "../../src/hook-install.ts";
import {
  checkSessionStartHookPinSkew,
  readClientMcpPin,
  extractFlairMcpPin,
} from "../../src/doctor-client.ts";
import { wireClaudeCode, clientConfigPath } from "../../src/install/clients.ts";
import { mcpServerSpec, flairCliVersion, FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";

/**
 * flair#1516 — `flair upgrade` re-pins wired MCP CLIENT configs to the new
 * @tpsdev-ai/flair-mcp@<version> but used to leave the SessionStart HOOK
 * command on the OLD one. So a user who upgraded by the documented path kept
 * launching the previous adapter on every session, silently, and `flair
 * doctor` reported the hook "still runs" without ever comparing the two pins.
 *
 * These tests cover the two halves of the fix:
 *   1. repinSessionStartHook — the primitive `flair upgrade` now calls to move
 *      an already-wired hook to the current spec (never adding one).
 *   2. checkSessionStartHookPinSkew — the pin-vs-pin comparison `flair doctor`
 *      now flags.
 *
 * MUTATION-PROVEN: the end-to-end "init@old → upgrade" test asserts the hook
 * pin equals the client pin AND that BOTH moved to the current version — it
 * fails if the hook re-pin is reverted (the hook would stay on the old pin),
 * which the "without the re-pin" companion assertion demonstrates directly.
 */

const CURRENT_SPEC = mcpServerSpec();
const CURRENT_VER = flairCliVersion();
const STALE_VER = "0.0.0"; // a version that will never match the running CLI
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-repin-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

/** The canonical (current-form, silenced) Flair SessionStart hook command,
 *  pinned to a specific flair-mcp version — the exact shape `flair init` /
 *  `flair hook install` write. */
function hookCommand(agentId: string, version: string): string {
  return `sh -c 'out=$(FLAIR_AGENT_ID=${agentId} npx -y -p ${FLAIR_MCP_PACKAGE}@${version} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

function writeClaudeHook(home: string, command: string): string {
  const path = hookSettingsPath(home, "claude-code");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n");
  return path;
}

function writeClaudeMcp(home: string, spec: string, agentId = "local"): string {
  const path = clientConfigPath("claude-code");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    mcpServers: { flair: { command: "npx", args: ["-y", spec], type: "stdio", env: { FLAIR_AGENT_ID: agentId } } },
  }, null, 2) + "\n");
  return path;
}

/** Read the flair-mcp version pinned in the wired SessionStart hook command. */
function readHookPin(home: string): string | null {
  const path = hookSettingsPath(home, "claude-code");
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  const cmd = cfg?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
  return extractFlairMcpPin(cmd);
}

describe("flair#1516 — repinSessionStartHook re-pins a wired hook to the current spec", () => {
  it("stale hook → update: rewrites to the current version, preserving the agent id", () => {
    const path = writeClaudeHook(isoHome, hookCommand("myagent", STALE_VER));
    expect(readHookPin(isoHome)).toBe(STALE_VER);

    const res = repinSessionStartHook(isoHome, "claude-code");
    expect(res.ok).toBe(true);
    expect(res.action).toBe("update");
    expect(res.backupPath).not.toBeNull();

    // Now on the current pin, and the agent id is unchanged.
    expect(readHookPin(isoHome)).toBe(CURRENT_VER);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain(CURRENT_SPEC);
    expect(after).toContain("FLAIR_AGENT_ID=myagent");
    expect(after).not.toContain(STALE_SPEC);
  });

  it("current pin → noop: a second call is idempotent", () => {
    writeClaudeHook(isoHome, hookCommand("myagent", CURRENT_VER));
    const res = repinSessionStartHook(isoHome, "claude-code");
    expect(res.ok).toBe(true);
    expect(res.action).toBe("noop");
    expect(readHookPin(isoHome)).toBe(CURRENT_VER);
  });

  it("no hook present → skip: NEVER adds a hook (re-pin is not an opt-in)", () => {
    const res = repinSessionStartHook(isoHome, "claude-code");
    expect(res.ok).toBe(true);
    expect(res.action).toBe("skip");
    expect(existsSync(hookSettingsPath(isoHome, "claude-code"))).toBe(false);
  });

  it("hand-edited / legacy (no -p) command → skip: left untouched", () => {
    // The pre-#1143 legacy form has no `-p`; a version bump must not silently
    // rewrite it (doctor owns the legacy→current upgrade, with its own consent).
    const legacy = `sh -c 'FLAIR_AGENT_ID=x npx -y ${FLAIR_MCP_PACKAGE} flair-session-start'`;
    const path = writeClaudeHook(isoHome, legacy);
    const before = readFileSync(path, "utf-8");
    const res = repinSessionStartHook(isoHome, "claude-code");
    expect(res.action).toBe("skip");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

describe("flair#1516 — init@old → upgrade: the hook pin ends up equal to the MCP client pin (both new)", () => {
  it("re-pinning the client AND the hook lands both on the current version", () => {
    // 1. Post-`flair init` state, but at an OLD version: both the Claude Code
    //    MCP client block and the SessionStart hook are pinned to STALE.
    writeClaudeMcp(isoHome, STALE_SPEC, "local");
    writeClaudeHook(isoHome, hookCommand("local", STALE_VER));
    // Precondition: both stale and mutually consistent, but behind current.
    expect(readClientMcpPin("claude-code", isoHome)).toBe(STALE_VER);
    expect(readHookPin(isoHome)).toBe(STALE_VER);

    // 2. What `flair upgrade` does: refresh the client pin (client.wire) AND
    //    re-pin the hook (repinSessionStartHook) — the exact two steps.
    const wired = wireClaudeCode({ FLAIR_AGENT_ID: "local", FLAIR_URL: "http://127.0.0.1:9926", FLAIR_CLIENT: "claude-code" });
    expect(wired.ok).toBe(true);
    const repin = repinSessionStartHook(isoHome, "claude-code");
    expect(repin.action).toBe("update");

    // 3. ACCEPTANCE: hook pin == client pin, and both are the new version.
    const clientPin = readClientMcpPin("claude-code", isoHome);
    const hookPin = readHookPin(isoHome);
    expect(clientPin).toBe(CURRENT_VER);
    expect(hookPin).toBe(CURRENT_VER);
    expect(hookPin).toBe(clientPin);
    // And doctor would now see NO skew.
    expect(checkSessionStartHookPinSkew(isoHome, "claude-code").skewed).toBe(false);
  });

  it("WITHOUT the hook re-pin (the pre-#1516 bug), the hook stays behind the client — the fix is load-bearing", () => {
    writeClaudeMcp(isoHome, STALE_SPEC, "local");
    writeClaudeHook(isoHome, hookCommand("local", STALE_VER));

    // Only refresh the CLIENT pin (what `flair upgrade` did before #1516).
    wireClaudeCode({ FLAIR_AGENT_ID: "local", FLAIR_URL: "http://127.0.0.1:9926", FLAIR_CLIENT: "claude-code" });

    // The bug: client moved forward, hook did not — they now disagree.
    expect(readClientMcpPin("claude-code", isoHome)).toBe(CURRENT_VER);
    expect(readHookPin(isoHome)).toBe(STALE_VER);
    expect(readHookPin(isoHome)).not.toBe(readClientMcpPin("claude-code", isoHome));
    // And doctor now DOES see a skew (which the fix's re-pin resolves).
    expect(checkSessionStartHookPinSkew(isoHome, "claude-code").skewed).toBe(true);
  });
});

describe("flair#1516 — checkSessionStartHookPinSkew is what `flair doctor` flags", () => {
  it("hook behind client → skewed, with both pins reported", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    writeClaudeHook(isoHome, hookCommand("local", STALE_VER));
    const skew = checkSessionStartHookPinSkew(isoHome, "claude-code");
    expect(skew.hookWired).toBe(true);
    expect(skew.hookPin).toBe(STALE_VER);
    expect(skew.clientPin).toBe(CURRENT_VER);
    expect(skew.skewed).toBe(true);
  });

  it("hook and client on the same version → not skewed", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    writeClaudeHook(isoHome, hookCommand("local", CURRENT_VER));
    expect(checkSessionStartHookPinSkew(isoHome, "claude-code").skewed).toBe(false);
  });

  it("no hook wired → not skewed (nothing to compare)", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    const skew = checkSessionStartHookPinSkew(isoHome, "claude-code");
    expect(skew.hookWired).toBe(false);
    expect(skew.skewed).toBe(false);
  });

  it("unpinned hook (pre-#1143) → not a skew (no version to compare)", () => {
    writeClaudeMcp(isoHome, CURRENT_SPEC, "local");
    // Canonical -p form but with NO @version pin.
    writeClaudeHook(isoHome, `sh -c 'out=$(FLAIR_AGENT_ID=local npx -y -p ${FLAIR_MCP_PACKAGE} flair-session-start 2>/dev/null) && printf %s "$out" || true'`);
    const skew = checkSessionStartHookPinSkew(isoHome, "claude-code");
    expect(skew.hookWired).toBe(true);
    expect(skew.hookPin).toBeNull();
    expect(skew.skewed).toBe(false);
  });
});
