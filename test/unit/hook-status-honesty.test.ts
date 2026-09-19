import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as hookInstall from "../../src/hook-install.ts";
import {
  hookStatus,
  hookStatusFailureLine,
  installHook,
  hookSettingsPath,
  type HookStatusResult,
} from "../../src/hook-install.ts";
import { SESSION_START_HOOK_MARKER } from "../../src/doctor-client.ts";

/**
 * flair#1734 HALF 2 — `flair hook status` must report what it VERIFIED,
 * not what it CONFIGURED.
 *
 * The defect on main: after `installHook({ harness: "codex" })`, status is
 * `wired: true` and the CLI prints an unqualified `✓ wired`. That is true
 * when Codex's panel reads Installed 1 / Active 0 / Review 1, when the hook
 * agent id disagrees with `[mcp_servers.flair.env]`, and when bootstrap
 * returns empty context because the key does not validate.
 *
 * Required states:
 *   absent     — not configured
 *   unverified — configured, delivery NOT verified
 *   verified   — configured and delivery verified
 *
 * Never an unqualified "wired" for the middle case.
 * Never treat exit 0 (or inert `{}`) as delivery success.
 */

const AGENT = "gauge";
const OTHER_AGENT = "anvil";
const URL = "http://127.0.0.1:9926";

type DeliveryState = "verified" | "unverified" | "absent";

type HonestStatus = HookStatusResult & {
  delivery?: DeliveryState;
  deliveryReasons?: string[];
};

type HonestyExports = typeof hookInstall & {
  hookStatusHeadline?: (status: HookStatusResult) => string;
  classifyHookDelivery?: (outcome: {
    exitCode: number | null;
    stdout: string;
    stderr?: string;
    timedOut?: boolean;
    spawnError?: string | null;
  }) => { delivered: boolean; reason: string };
};

const honesty = hookInstall as HonestyExports;

let isoHome: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-hook-honesty-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

function statusOf(harness: "codex" | "claude-code"): HonestStatus {
  return hookStatus(isoHome, harness) as HonestStatus;
}

const SOUL_STDOUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: "## Identity\n**identity:** Gauge.",
  },
});

function deliveredProbe(): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: SOUL_STDOUT };
}

function installedCodexCommand(): string {
  const config = JSON.parse(readFileSync(hookSettingsPath(isoHome, "codex"), "utf-8"));
  const commands = (config.hooks?.SessionStart ?? []).flatMap((group: { hooks?: { command?: string }[] }) =>
    (group.hooks ?? []).map((hook) => hook.command ?? ""),
  );
  const ours = commands.find((command: string) => command.includes(SESSION_START_HOOK_MARKER));
  expect(ours).toBeDefined();
  return ours as string;
}

function writeCodexMcpAgent(agentId: string): void {
  mkdirSync(join(isoHome, ".codex"), { recursive: true });
  writeFileSync(
    join(isoHome, ".codex", "config.toml"),
    [
      "[mcp_servers.flair]",
      'command = "npx"',
      'args = ["-y", "@tpsdev-ai/flair-mcp"]',
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "${agentId}"`,
      "",
    ].join("\n"),
  );
}

describe("HALF 2 — status reports verified delivery, not a bare wired check", () => {
  it("exports a headline that can distinguish the three states", () => {
    expect(typeof honesty.hookStatusHeadline).toBe("function");
  });

  it("not configured → delivery absent, headline is not a green wired", () => {
    const status = statusOf("codex");
    expect(status.wired).toBe(false);
    expect(status.delivery).toBe("absent");
    const headline = honesty.hookStatusHeadline!(status);
    expect(headline.toLowerCase()).toMatch(/not configured|not wired/);
    expect(headline).not.toMatch(/^\s*wired\s*$/i);
    expect(headline).not.toContain("✓ wired");
  });

  it("fresh Codex install is configured but delivery is NOT verified (no harness trust, no effect probe)", () => {
    const result = installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    expect(result.ok).toBe(true);

    const status = statusOf("codex");
    expect(status.wired).toBe(true);
    expect(status.delivery).toBe("unverified");
    expect(status.deliveryReasons?.join(" ")).toMatch(/trust|untrusted|approv|verified/i);

    const headline = honesty.hookStatusHeadline!(status);
    expect(headline).not.toMatch(/^\s*wired\s*$/i);
    expect(headline).not.toBe("wired");
    expect(headline).not.toContain("✓ wired");
    expect(headline.toLowerCase()).toMatch(/not verified|unverified|untrusted|pending/);
  });

  it("must fail if status still says plain 'wired' when Codex will not run the hook", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    writeFileSync(
      join(isoHome, ".codex", "config.toml"),
      ["[features]", "hooks = false", ""].join("\n"),
    );

    const status = statusOf("codex");
    expect(status.wired).toBe(true);
    expect(status.delivery).toBe("unverified");
    expect(status.deliveryReasons?.join(" ")).toMatch(/disabled|features\.hooks|not run/i);

    const headline = honesty.hookStatusHeadline!(status);
    expect(headline).not.toMatch(/^\s*wired\s*$/i);
    expect(headline).not.toContain("✓ wired");
  });

  it("agent-id drift between hooks.json and config.toml MCP env is unverified, not wired-all-clear", () => {
    writeCodexMcpAgent(OTHER_AGENT);
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });

    const status = statusOf("codex");
    expect(status.agentId).toBe(AGENT);
    expect(status.delivery).toBe("unverified");
    expect(status.deliveryReasons?.join(" ")).toMatch(/agent|drift|disagree|mismatch/i);

    const headline = honesty.hookStatusHeadline!(status);
    expect(headline).not.toMatch(/^\s*wired\s*$/i);
    expect(headline).not.toContain("✓ wired");
  });

  it("a recorded trusted_hash alone does not make delivery verified", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    const hooksPath = hookSettingsPath(isoHome, "codex");
    writeFileSync(
      join(isoHome, ".codex", "config.toml"),
      [
        `[hooks.state."${hooksPath}:session_start:0:0"]`,
        'trusted_hash = "sha256:not-recomputed-by-flair"',
        "",
      ].join("\n"),
    );

    const status = statusOf("codex");
    expect(status.wired).toBe(true);
    expect(status.delivery).toBe("unverified");
    const headline = honesty.hookStatusHeadline!(status);
    expect(headline).not.toMatch(/^\s*wired\s*$/i);
    expect(headline).not.toContain("✓ wired");
  });
});

describe("HALF 2 — delivery classification does not treat exit 0 as success", () => {
  it("exports classifyHookDelivery", () => {
    expect(typeof honesty.classifyHookDelivery).toBe("function");
  });

  it("exit 0 with inert {} is NOT delivered", () => {
    const verdict = honesty.classifyHookDelivery!({ exitCode: 0, stdout: "{}" });
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/empty|inert|no context|not delivered/i);
  });

  it("exit 0 with empty stdout is NOT delivered", () => {
    const verdict = honesty.classifyHookDelivery!({ exitCode: 0, stdout: "" });
    expect(verdict.delivered).toBe(false);
  });

  it("exit 0 with SessionStart additionalContext is delivered", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "## Identity\n**identity:** Gauge.",
      },
    });
    const verdict = honesty.classifyHookDelivery!({ exitCode: 0, stdout });
    expect(verdict.delivered).toBe(true);
  });

  it("non-zero exit is NOT delivered even if stdout looks like context", () => {
    const verdict = honesty.classifyHookDelivery!({
      exitCode: 1,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "nope" },
      }),
    });
    expect(verdict.delivered).toBe(false);
  });
});

describe("HALF 1 — Codex install identifies the harness to the binary", () => {
  it("Codex hook command sets FLAIR_HOOK_HARNESS=codex", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    expect(installedCodexCommand()).toContain("FLAIR_HOOK_HARNESS=codex");
  });

  it("Claude Code hook command does not claim to be Codex", () => {
    installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
    const config = JSON.parse(readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8"));
    const command = config.hooks.SessionStart[0].hooks[0].command as string;
    expect(command).not.toContain("FLAIR_HOOK_HARNESS=codex");
  });
});

describe("install / detectability (issue #1734 surviving asks)", () => {
  it("Codex install success text names the re-approval requirement", () => {
    const result = installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    expect(result.ok).toBe(true);
    // Must not match the file path `.../.codex/hooks.json` — that is how a
    // `/hooks/` regex accidentally passed on main.
    expect(result.message).toMatch(/re-approval/i);
  });

  it("Codex wired command does not swallow stderr with 2>/dev/null", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    expect(installedCodexCommand()).not.toContain("2>/dev/null");
  });

  it("Codex status must not claim failures stay silent with no output", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    const status = statusOf("codex");
    expect(status.stderrDiscarded).toBe(false);
    expect(status.silenced).toBe(true);
    expect(hookStatusFailureLine(status)).toMatch(/stderr is visible/i);
    expect(hookStatusFailureLine(status)).not.toMatch(/no output/i);
  });
});

describe("HALF 2 — verified is reachable when delivery is classified", () => {
  it("injected SessionStart additionalContext + no blockers → verified", () => {
    writeCodexMcpAgent(AGENT);
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    const status = hookStatus(isoHome, "codex", { deliveryProbe: deliveredProbe });
    expect(status.delivery).toBe("verified");
    expect(honesty.hookStatusHeadline!(status).toLowerCase()).toMatch(/verified/);
    expect(honesty.hookStatusHeadline!(status)).not.toMatch(/^\s*wired\s*$/i);
  });

  it("additionalContext does not verify when Codex hooks are disabled", () => {
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    writeFileSync(join(isoHome, ".codex", "config.toml"), ["[features]", "hooks = false", ""].join("\n"));
    const status = hookStatus(isoHome, "codex", { deliveryProbe: deliveredProbe });
    expect(status.delivery).toBe("unverified");
    expect(status.deliveryReasons.join(" ")).toMatch(/disabled|features\.hooks|not run/i);
  });

  it("exit 0 + inert {} stays unverified even with an injected probe", () => {
    writeCodexMcpAgent(AGENT);
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    const status = hookStatus(isoHome, "codex", {
      deliveryProbe: () => ({ exitCode: 0, stdout: "{}" }),
    });
    expect(status.delivery).toBe("unverified");
  });
});

describe("HALF 2 — status does not spawn a stranger hook", () => {
  function writeStrangerHook(command: string): void {
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    writeFileSync(
      hookSettingsPath(isoHome, "codex"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
      }),
    );
  }

  it("does not probe a marker-only decoy", () => {
    writeStrangerHook(`echo ${SESSION_START_HOOK_MARKER}-decoy`);
    let probed = false;
    const status = hookStatus(isoHome, "codex", {
      deliveryProbe: () => {
        probed = true;
        return deliveredProbe();
      },
    });
    expect(probed).toBe(false);
    expect(status.delivery).toBe("unverified");
    expect(status.deliveryReasons.join(" ")).toMatch(/not probed|installer shape/i);
  });

  it("does not probe my-own-flair-session-start-script.sh", () => {
    writeStrangerHook("my-own-flair-session-start-script.sh");
    let probed = false;
    const status = hookStatus(isoHome, "codex", {
      deliveryProbe: () => {
        probed = true;
        return deliveredProbe();
      },
    });
    expect(probed).toBe(false);
    expect(status.wired).toBe(true);
    expect(status.delivery).toBe("unverified");
  });
});

describe("HALF 2 — probe timeout and spawn errors are not exited null", () => {
  it("timedOut is reported as a timeout, not exited null", () => {
    const verdict = honesty.classifyHookDelivery!({
      exitCode: null,
      stdout: "",
      timedOut: true,
    });
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/timed out/i);
    expect(verdict.reason).not.toMatch(/exited null/i);
  });

  it("spawnError is reported as a spawn failure, not exited null", () => {
    const verdict = honesty.classifyHookDelivery!({
      exitCode: null,
      stdout: "",
      spawnError: "ENOENT",
    });
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/spawn|ENOENT/i);
    expect(verdict.reason).not.toMatch(/exited null/i);
  });

  it("hookStatus surfaces a timed-out probe on an installer-shaped command", () => {
    writeCodexMcpAgent(AGENT);
    installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
    const status = hookStatus(isoHome, "codex", {
      deliveryProbe: () => ({ exitCode: null, stdout: "", timedOut: true }),
    });
    expect(status.delivery).toBe("unverified");
    expect(status.deliveryReasons.join(" ")).toMatch(/timed out/i);
    expect(status.deliveryReasons.join(" ")).not.toMatch(/exited null/i);
  });
});
