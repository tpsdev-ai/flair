// flair#1208 — `flair upgrade` must detect flair-mcp by its ACTUAL wiring, not
// a global-install probe. flair-mcp is zero-install via npx (#1168), so a
// correctly-wired machine never has it globally; the global probe returning
// null is the NORMAL state, not "missing".
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFlairMcpFinding } from "../../src/cli";
import {
  extractFlairMcpPin,
  detectWiredFlairMcp,
  buildSessionStartHookCommand,
} from "../../src/doctor-client";
import { flairCliVersion } from "../../src/lib/mcp-spec";

const LATEST = "0.44.9";

// ── the pure resolver: global probe + wiring -> {installed, status} ──────────
describe("resolveFlairMcpFinding", () => {
  test("legacy global install matching latest => current (honors the probe)", () => {
    expect(resolveFlairMcpFinding(LATEST, LATEST, { wired: false, pinnedVersion: null }))
      .toEqual({ installed: LATEST, status: "current" });
  });

  test("legacy global install behind latest => outdated", () => {
    expect(resolveFlairMcpFinding("0.44.5", LATEST, { wired: false, pinnedVersion: null }))
      .toEqual({ installed: "0.44.5", status: "outdated" });
  });

  test("global probe null + NOT wired anywhere => missing", () => {
    expect(resolveFlairMcpFinding(null, LATEST, { wired: false, pinnedVersion: null }))
      .toEqual({ installed: null, status: "missing" });
  });

  // The core acceptance of #1208: a null global probe on a WIRED machine must
  // NOT be "missing".
  test("global probe null + wired with a pin == latest => current from wiring, NOT missing", () => {
    const finding = resolveFlairMcpFinding(null, LATEST, { wired: true, pinnedVersion: LATEST });
    expect(finding.status).toBe("current");
    expect(finding.installed).toBe(LATEST);
    expect(finding.status).not.toBe("missing");
  });

  test("global probe null + wired with a stale pin => outdated (shows the pin), NOT missing", () => {
    const finding = resolveFlairMcpFinding(null, LATEST, { wired: true, pinnedVersion: "0.44.5" });
    expect(finding).toEqual({ installed: "0.44.5", status: "outdated" });
    expect(finding.status).not.toBe("missing");
  });

  test("global probe null + wired but UNPINNED (bare npx / hook) => current at latest", () => {
    // A bare `npx -y` re-resolves latest every session, so the effective
    // installed version IS latest.
    const finding = resolveFlairMcpFinding(null, LATEST, { wired: true, pinnedVersion: null });
    expect(finding).toEqual({ installed: LATEST, status: "current" });
    expect(finding.status).not.toBe("missing");
  });
});

// ── pin extraction ──────────────────────────────────────────────────────────
describe("extractFlairMcpPin", () => {
  test("pulls the version from a pinned client args spec", () => {
    expect(extractFlairMcpPin('"args": ["-y", "@tpsdev-ai/flair-mcp@0.44.5"]')).toBe("0.44.5");
  });

  test("pulls the version from a pinned Codex TOML args line", () => {
    expect(extractFlairMcpPin('args = ["-y", "@tpsdev-ai/flair-mcp@1.2.3-rc.1"]')).toBe("1.2.3-rc.1");
  });

  test("returns null for a bare/unpinned spec", () => {
    expect(extractFlairMcpPin('"args": ["-y", "@tpsdev-ai/flair-mcp"]')).toBeNull();
  });

  test("pulls the version from the SessionStart hook command (flair#1143)", () => {
    expect(extractFlairMcpPin(buildSessionStartHookCommand("me"))).toBe(flairCliVersion());
  });

  test("returns null for a pre-#1143 unpinned SessionStart hook command", () => {
    expect(extractFlairMcpPin(`FLAIR_AGENT_ID=me npx -y -p @tpsdev-ai/flair-mcp flair-session-start`)).toBeNull();
  });

  test("returns null when the package is absent entirely", () => {
    expect(extractFlairMcpPin('"args": ["-y", "some-other-package@1.0.0"]')).toBeNull();
  });
});

// ── the real code path: read a temp HOME's wiring files ─────────────────────
describe("detectWiredFlairMcp (reads actual config files under HOME)", () => {
  function withTempHome(fn: (home: string) => void): void {
    const home = mkdtempSync(join(tmpdir(), "flair-mcp-detect-"));
    try {
      fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("empty HOME => not wired", () => {
    withTempHome((home) => {
      expect(detectWiredFlairMcp(home)).toEqual({ wired: false, pinnedVersion: null });
    });
  });

  test("SessionStart hook present => wired, pin extracted (flair#1143)", () => {
    withTempHome((home) => {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: buildSessionStartHookCommand("me") }] }] },
        }),
      );
      expect(detectWiredFlairMcp(home)).toEqual({ wired: true, pinnedVersion: flairCliVersion() });
    });
  });

  test("client MCP config with a pinned flair server => wired, pin extracted", () => {
    withTempHome((home) => {
      mkdirSync(join(home, ".gemini"), { recursive: true });
      writeFileSync(
        join(home, ".gemini", "settings.json"),
        JSON.stringify({
          mcpServers: {
            flair: {
              command: "npx",
              args: ["-y", "@tpsdev-ai/flair-mcp@0.44.5"],
              env: { FLAIR_AGENT_ID: "me", FLAIR_URL: "http://127.0.0.1:9926" },
            },
          },
        }),
      );
      expect(detectWiredFlairMcp(home)).toEqual({ wired: true, pinnedVersion: "0.44.5" });
    });
  });

  test("hook present but NO global install => resolves to current, NOT missing (issue #1208 acceptance)", () => {
    withTempHome((home) => {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: buildSessionStartHookCommand("me") }] }] },
        }),
      );
      // globalProbe null (not globally installed) + hook present. The hook
      // now carries a pin (flair#1143); treat that pin as latest so this
      // test still asserts "not missing", not "outdated vs a fixture tag".
      const wiring = detectWiredFlairMcp(home);
      expect(wiring.wired).toBe(true);
      expect(wiring.pinnedVersion).toBe(flairCliVersion());
      const finding = resolveFlairMcpFinding(null, wiring.pinnedVersion!, wiring);
      expect(finding.status).not.toBe("missing");
      expect(finding).toEqual({ installed: wiring.pinnedVersion, status: "current" });
    });
  });
});
