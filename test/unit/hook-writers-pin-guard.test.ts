// hook-writers-pin-guard.test.ts — flair#1778 slice 2c-i-a3.
//
// The SessionStart hook file has two version-carrying writers in
// src/hook-install.ts (installHook via computeInstallDelta, and the EXPORTED
// raw writer repinSessionStartHook) plus two in src/doctor-client.ts
// (fixSessionStartHook's add arm, upgradeSessionStartHookCommand's legacy
// repair). Every one of them now consults the ONE never-lower guard
// (src/lib/pin-write-guard.ts's decidePinWrite) before replacing an entry, so
// a re-run on an older CLI, a shared config, or a hand-pinned newer version
// can no longer lower the pin.
//
// Fixture (10): each case SETS the field to the spec under test and reads it
// back before the guarded write — a hand-written config is presence, not
// validity — then drives the REAL production writer and asserts the bytes.
// The removal writers are covered here too, to show they carry no version.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fixSessionStartHook, upgradeSessionStartHookCommand } from "../../src/doctor-client.ts";
import { hookSettingsPath, installHook, repinSessionStartHook, uninstallHook } from "../../src/hook-install.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const HARNESS = "claude-code" as const;
const AGENT = "hookbot";
const URL = "http://127.0.0.1:19926";
const RUN = flairCliVersion();
const AHEAD_SPEC = `${FLAIR_MCP_PACKAGE}@9.9.9`;
const BEHIND_SPEC = `${FLAIR_MCP_PACKAGE}@0.0.1`;
const UNPINNED_SPEC = FLAIR_MCP_PACKAGE;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-hook-guard-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

const settingsPath = () => hookSettingsPath(isoHome, HARNESS);

/** The installer-shape SessionStart command carrying `spec` and `agent`. */
function hookCommand(spec: string, agent = AGENT): string {
  return (
    `sh -c 'out=$(FLAIR_AGENT_ID=${agent} FLAIR_URL=${URL} npx -y -p ${spec} ` +
    `flair-session-start 2>/dev/null) && printf %s "$out" || true'`
  );
}

/** Write a settings file whose SessionStart hook carries `spec`. */
function writeHook(spec: string, agent = AGENT, extraGroups: unknown[] = []): string {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand(spec, agent) }] }, ...extraGroups] } },
      null,
      2,
    ) + "\n",
  );
  return path;
}

function readSessionStart(): any[] | undefined {
  if (!existsSync(settingsPath())) return undefined;
  return JSON.parse(readFileSync(settingsPath(), "utf-8"))?.hooks?.SessionStart;
}

function readCommand(): string | null {
  return readSessionStart()?.[0]?.hooks?.[0]?.command ?? null;
}

const install = () => installHook({ homeDir: isoHome, harness: HARNESS, agentId: AGENT, flairUrl: URL });

// ── installHook (computeInstallDelta's writer) ──────────────────────────────

describe("installHook — the SessionStart pin is never lowered", () => {
  it("AHEAD → HELD, bytes UNCHANGED, the line names the entries", () => {
    const path = writeHook(AHEAD_SPEC);
    const before = readFileSync(path, "utf-8");
    expect(readFileSync(path, "utf-8")).toContain(AHEAD_SPEC); // (10) genuine fixture

    const res = install();

    expect(res.ok).toBe(true);
    expect(res.message).toContain("holding");
    expect(res.message).toContain("9.9.9");
    expect(res.message).toContain(RUN);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  for (const spec of [
    `${FLAIR_MCP_PACKAGE}@^0.55.0`,
    `${FLAIR_MCP_PACKAGE}@latest`,
    `${FLAIR_MCP_PACKAGE}@v0.55.0`,
    `${FLAIR_MCP_PACKAGE}@1.2.3.4`,
    `${FLAIR_MCP_PACKAGE}@file:../x`,
    `${FLAIR_MCP_PACKAGE}@github:o/r`,
  ]) {
    it(`range/tag/malformed/unsupported ${spec} → HELD, bytes preserved verbatim`, () => {
      const path = writeHook(spec);
      const before = readFileSync(path, "utf-8");
      const res = install();
      expect(res.message).toContain("holding");
      expect(readFileSync(path, "utf-8")).toBe(before);
    });
  }

  it("BEHIND → repinned UP to the running CLI (positive control)", () => {
    writeHook(BEHIND_SPEC);
    expect(readCommand()).toContain(BEHIND_SPEC);

    const res = install();

    expect(res.ok).toBe(true);
    expect(readCommand()).toContain(mcpServerSpec());
    expect(readCommand()).not.toContain(BEHIND_SPEC);
    expect(res.message).toContain("updated");
  });

  it("unpinned (pre-#1143 -p form) → pinned UP to the running CLI (positive control)", () => {
    writeHook(UNPINNED_SPEC);
    expect(readCommand()).toContain(`-p ${UNPINNED_SPEC} `);

    install();

    expect(readCommand()).toContain(mcpServerSpec());
  });

  it("absent (no hook) → the hook is ADDED, pinned to the running CLI", () => {
    expect(existsSync(settingsPath())).toBe(false);

    const res = install();

    expect(res.ok).toBe(true);
    expect(readCommand()).toContain(mcpServerSpec());
  });

  it("equal version, different agent id → shape repair Writes (same pin, not a lowering)", () => {
    writeHook(String(mcpServerSpec()), "someone-else");
    expect(readCommand()).toContain("FLAIR_AGENT_ID=someone-else");

    const res = install();

    expect(res.ok).toBe(true);
    expect(readCommand()).toContain("FLAIR_AGENT_ID=hookbot");
    expect(readCommand()).toContain(mcpServerSpec()); // pin unchanged
  });

  it("a hold preserves SIBLING SessionStart groups byte-identically", () => {
    const sibling = { hooks: [{ type: "command", command: "echo keep-me" }] };
    const path = writeHook(AHEAD_SPEC, AGENT, [sibling]);
    const before = readFileSync(path, "utf-8");

    install();

    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(readSessionStart()?.[1]).toEqual(sibling);
  });
});

// ── repinSessionStartHook (the EXPORTED raw writer) ─────────────────────────

describe("repinSessionStartHook — the raw writer guards itself", () => {
  it("AHEAD → hold + a held line, bytes UNCHANGED", () => {
    const path = writeHook(AHEAD_SPEC);
    expect(readFileSync(path, "utf-8")).toContain(AHEAD_SPEC);
    const before = readFileSync(path, "utf-8");

    const res = repinSessionStartHook(isoHome, HARNESS);

    expect(res.ok).toBe(true);
    // flair#1834 PR-H: a hold is its own action, not a quiet skip.
    expect(res.action).toBe("hold");
    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("BEHIND → re-pinned UP (positive control)", () => {
    writeHook(BEHIND_SPEC);
    expect(readCommand()).toContain(BEHIND_SPEC);

    const res = repinSessionStartHook(isoHome, HARNESS);

    expect(res.ok).toBe(true);
    expect(res.action).toBe("update");
    expect(readCommand()).toContain(mcpServerSpec());
  });

  it("no hook → a clean skip that adds nothing (never adds a hook)", () => {
    const res = repinSessionStartHook(isoHome, HARNESS);
    expect(res.action).toBe("skip");
    expect(existsSync(settingsPath())).toBe(false);
  });
});

// ── doctor's two writers ────────────────────────────────────────────────────

describe("doctor-client SessionStart writers", () => {
  it("fixSessionStartHook: absent → added, pinned to the running CLI", () => {
    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(true);
    expect(readCommand()).toContain(mcpServerSpec());
  });

  it("fixSessionStartHook: already present → no write (an AHEAD pin is left alone)", () => {
    const path = writeHook(AHEAD_SPEC);
    const before = readFileSync(path, "utf-8");
    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("upgradeSessionStartHookCommand: a legacy (unpinned, pre-#1007) command is repaired to the pinned, silenced form", () => {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = `FLAIR_AGENT_ID=${AGENT} npx -y @tpsdev-ai/flair-mcp flair-session-start`;
    writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: legacy }] }] } }, null, 2) + "\n");

    const res = upgradeSessionStartHookCommand(isoHome);

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(readCommand()).toContain(mcpServerSpec());
  });

  it("upgradeSessionStartHookCommand: an already-silenced pinned hook is a no-op (no lowering)", () => {
    const path = writeHook(String(mcpServerSpec()));
    const before = readFileSync(path, "utf-8");
    const res = upgradeSessionStartHookCommand(isoHome);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

// ── removal writers do not carry a version ──────────────────────────────────

describe("removal carries no version", () => {
  it("uninstallHook removes ONLY our entry and preserves a sibling's pin byte-identically", () => {
    const sibling = { hooks: [{ type: "command", command: hookCommand(`${FLAIR_MCP_PACKAGE}@9.9.9`, "other") }] };
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const own = { hooks: [{ type: "command", command: hookCommand(String(mcpServerSpec())) }] };
    writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [own, sibling] } }, null, 2) + "\n");

    const res = uninstallHook({ homeDir: isoHome, harness: HARNESS });

    expect(res.ok).toBe(true);
    const after = readSessionStart();
    expect(after).toEqual([sibling]); // our entry gone, the sibling's pin untouched
  });
});
