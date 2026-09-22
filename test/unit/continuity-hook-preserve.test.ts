// continuity-hook-preserve.test.ts — flair#1778 slice 2c-i-a3, fixture (7).
//
// The continuity capture pair's command was written UNPINNED unconditionally
// (doctor-client.ts's builder). Repairing a PINNED continuity entry therefore
// silently UNPINNED it — a live lowering (Kern's #1812 finding). This slice
// gives continuity a preserve mode: a repair keeps the entry's OWN pin state.
//
// The three cases below drive the REAL doctor path (`fixContinuityCaptureHooks`
// — the function `flair doctor --fix` calls) and the hook-install path
// (`installContinuityHooks`), and assert the exact bytes written:
//   1. an UNPINNED entry that needs repair is repaired and STAYS unpinned;
//   2. an ABSENT hook is provisioned PINNED to the running CLI;
//   3. a PINNED entry that is repaired KEEPS its pin (fails on main today).
// Plus the never-lower rows: an AHEAD or non-comparable continuity pin holds.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONTINUITY_CAPTURE_HOOK_MARKER,
  CONTINUITY_POST_TOOL_USE_MATCHER,
  checkContinuityCaptureHooks,
  fixContinuityCaptureHooks,
} from "../../src/doctor-client.ts";
import { installContinuityHooks } from "../../src/hook-install.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const AGENT = "contbot";
const URL = "http://127.0.0.1:19926";
const RUN = flairCliVersion();
const AHEAD_SPEC = `${FLAIR_MCP_PACKAGE}@9.9.9`;
const UNPINNED_SPEC = FLAIR_MCP_PACKAGE;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-cont-preserve-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function settingsPath(): string {
  return join(isoHome, ".claude", "settings.json");
}

/** The exact silenced continuity command for a given spec. */
function contCommand(spec: string): string {
  return `sh -c 'FLAIR_AGENT_ID=${AGENT} FLAIR_URL=${URL} npx -y -p ${spec} ${CONTINUITY_CAPTURE_HOOK_MARKER} >/dev/null 2>/dev/null || true'`;
}

/** Write a settings file with the continuity pair at `spec` and a matcher. */
function writeContinuity(spec: string, matcher: string = CONTINUITY_POST_TOOL_USE_MATCHER): string {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const command = contCommand(spec);
  writeFileSync(
    path,
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [{ matcher, hooks: [{ type: "command", command }] }],
          Stop: [{ hooks: [{ type: "command", command }] }],
        },
      },
      null,
      2,
    ) + "\n",
  );
  return path;
}

function readCommand(event: "PostToolUse" | "Stop"): string | null {
  const cfg = JSON.parse(readFileSync(settingsPath(), "utf-8"));
  return cfg?.hooks?.[event]?.[0]?.hooks?.[0]?.command ?? null;
}

describe("continuity-preserve — the real doctor path (fixture 7)", () => {
  it("CASE 1: an UNPINNED command that needs repair is repaired and STAYS unpinned", () => {
    // Stale PostToolUse matcher forces a repair; the command itself is unpinned.
    writeContinuity(UNPINNED_SPEC, "Bash");
    expect(readCommand("PostToolUse")).toBe(contCommand(UNPINNED_SPEC));

    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(readCommand("PostToolUse")).toBe(contCommand(UNPINNED_SPEC)); // still unpinned
    expect(readCommand("Stop")).toBe(contCommand(UNPINNED_SPEC));
    const cfg = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    expect(cfg.hooks.PostToolUse[0].matcher).toBe(CONTINUITY_POST_TOOL_USE_MATCHER); // repaired
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("installed");
  });

  it("CASE 2: an ABSENT continuity hook is provisioned PINNED to the running CLI", () => {
    expect(existsSync(settingsPath())).toBe(false);

    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);

    expect(res.ok).toBe(true);
    expect(readCommand("PostToolUse")).toBe(contCommand(String(mcpServerSpec())));
    expect(readCommand("Stop")).toBe(contCommand(String(mcpServerSpec())));
    expect(checkContinuityCaptureHooks(isoHome).state).toBe("installed");
  });

  it("CASE 3: a PINNED entry that is repaired KEEPS its pin (fails on main today)", () => {
    // Pinned to the running CLI, with a stale matcher so a repair really happens.
    writeContinuity(String(mcpServerSpec()), "Bash");
    expect(readCommand("PostToolUse")).toBe(contCommand(String(mcpServerSpec())));

    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);

    expect(res.ok).toBe(true);
    // The pin survives: on main this line reads the UNPINNED command.
    expect(readCommand("PostToolUse")).toBe(contCommand(String(mcpServerSpec())));
    expect(readCommand("PostToolUse")).toContain(`@${RUN}`);
    const cfg = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    expect(cfg.hooks.PostToolUse[0].matcher).toBe(CONTINUITY_POST_TOOL_USE_MATCHER);
  });

  it("an AHEAD continuity pin HOLDS — nothing written, bytes byte-identical", () => {
    const path = writeContinuity(AHEAD_SPEC, "Bash"); // needs repair, but is ahead
    const before = readFileSync(path, "utf-8");

    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);

    expect(res.ok).toBe(true);
    expect(res.message).toContain("holding");
    expect(res.message).toContain("9.9.9");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("a range continuity pin HOLDS (present, not comparable)", () => {
    const path = writeContinuity(`${FLAIR_MCP_PACKAGE}@^0.55.0`, "Bash");
    const before = readFileSync(path, "utf-8");

    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);

    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

describe("continuity-preserve — the hook-install path", () => {
  it("absent → provisioned pinned; a second run is a noop", () => {
    const first = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(first.ok).toBe(true);
    expect(readCommand("Stop")).toBe(contCommand(String(mcpServerSpec())));

    const second = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(second.ok).toBe(true);
    expect(second.message).toContain("already current");
  });

  it("a PINNED entry is repaired keeping its pin (never unpinned)", () => {
    const path = writeContinuity(String(mcpServerSpec()), "Bash");
    installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(readCommand("PostToolUse")).toContain(`@${RUN}`);
    expect(readFileSync(path, "utf-8")).toContain(`@${RUN}`);
  });

  it("an AHEAD entry holds through the hook-install path too", () => {
    const path = writeContinuity(AHEAD_SPEC, "Bash");
    const before = readFileSync(path, "utf-8");
    const res = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});
