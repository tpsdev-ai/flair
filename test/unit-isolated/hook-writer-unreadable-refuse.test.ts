// hook-writer-unreadable-refuse.test.ts — flair#1778 slice 2c-i-a3, fixture (9)
// plus the #1812 review carry-over.
//
// When the RUNNING CLI cannot read its own version, every hook writer REFUSES
// by name and writes nothing — the named change replacing mcp-spec's fallback
// to the UNPINNED spec. The carry-over fixture is the fresh-home consequence:
// the same refusal ALSO declines a legitimate FIRST install on a fresh home
// (nothing is created), which the refused line now names.
//
// `flairCliVersion` is mocked to "unknown" for this file only, before the
// modules under test are imported. Lives in test/unit-isolated/ because
// mock.module is process-global.

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

const { installHook, hookSettingsPath } = await import("../../src/hook-install.ts");
const { fixSessionStartHook, fixContinuityCaptureHooks } = await import("../../src/doctor-client.ts");

const AGENT = "refbot";
const URL = "http://127.0.0.1:19926";

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-hook-refuse-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

const settingsPath = () => hookSettingsPath(isoHome, "claude-code");

describe("fixture (9): an unreadable running version refuses, nothing written", () => {
  it("installHook on a FRESH home → refusal by name, nothing created (carry-over)", () => {
    expect(existsSync(settingsPath())).toBe(false);

    const res = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });

    expect(res.message).toContain("REFUSING");
    expect(res.message).toContain("FIRST install");
    expect(existsSync(settingsPath())).toBe(false); // nothing created
  });

  it("installHook over a pinned entry → refusal, bytes byte-identical (no unpinned fallback)", () => {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `sh -c 'out=$(FLAIR_AGENT_ID=${AGENT} FLAIR_URL=${URL} npx -y -p @tpsdev-ai/flair-mcp@0.0.1 flair-session-start 2>/dev/null) && printf %s "$out" || true'`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    const before = readFileSync(settingsPath(), "utf-8");

    const res = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });

    expect(res.message).toContain("REFUSING");
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("fixSessionStartHook (doctor) absent → refusal by name, nothing created", () => {
    const res = fixSessionStartHook(isoHome, AGENT);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("REFUSING");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("fixContinuityCaptureHooks (doctor) absent → refusal by name, nothing created", () => {
    const res = fixContinuityCaptureHooks(isoHome, AGENT, URL);
    expect(res.message).toContain("REFUSING");
    expect(existsSync(settingsPath())).toBe(false);
  });
});
