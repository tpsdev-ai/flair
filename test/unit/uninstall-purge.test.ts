/**
 * flair#853 — uninstall --purge completeness.
 *
 * Purge used to delete only ~/.flair/data and ~/.flair/keys, then print
 * "Flair fully purged" while leaving admin-pass, backups/logs/snapshots,
 * the REM nightly shim, MCP/hook wiring, and scheduler units. These tests
 * plant every leftover named in the issue and assert purge removes them
 * (or names the npm package as an intentional leftover).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  wireClaudeCode,
  wireCodex,
  wireGemini,
  wireCursor,
  ALL_CLIENTS,
  removeCodexFlairBlock,
  appendCodexFlairBlock,
  codexConfigHasFlairSection,
} from "../../src/install/clients.ts";
import { installHook, installContinuityHooks, hookSettingsPath } from "../../src/hook-install.ts";
import {
  purgeFlairInstall,
  formatPurgeReport,
  purgeHadFailures,
  FLAIR_NPM_PACKAGE,
} from "../../src/lib/uninstall-purge.ts";
import { LAUNCHD_LABEL as REM_LAUNCHD_LABEL, SYSTEMD_TIMER_UNIT as REM_TIMER, SYSTEMD_SERVICE_UNIT as REM_SERVICE } from "../../src/rem/scheduler.ts";
import { LAUNCHD_LABEL as FED_LAUNCHD_LABEL, SYSTEMD_TIMER_UNIT as FED_TIMER, SYSTEMD_SERVICE_UNIT as FED_SERVICE } from "../../src/federation/scheduler.ts";

const AGENT = "purgebot";
const URL = "http://127.0.0.1:19926";
const ENV = { FLAIR_AGENT_ID: AGENT, FLAIR_URL: URL };

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-purge-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function plantIssue853Leftovers(): {
  adminPass: string;
  backups: string;
  logs: string;
  snapshots: string;
  remShim: string;
  remTimer: string;
  remService: string;
  remPlist: string;
  claudeJson: string;
  codexToml: string;
  dataMarker: string;
  keysMarker: string;
} {
  const flair = join(isoHome, ".flair");
  mkdirSync(join(flair, "data"), { recursive: true });
  mkdirSync(join(flair, "keys"), { recursive: true });
  mkdirSync(join(flair, "backups"), { recursive: true });
  mkdirSync(join(flair, "logs"), { recursive: true });
  mkdirSync(join(flair, "upgrade-snapshots"), { recursive: true });
  mkdirSync(join(flair, "bin"), { recursive: true });
  mkdirSync(join(isoHome, ".config", "systemd", "user"), { recursive: true });
  mkdirSync(join(isoHome, "Library", "LaunchAgents"), { recursive: true });

  const adminPass = join(flair, "admin-pass");
  writeFileSync(adminPass, "super-secret-admin-pass\n", { mode: 0o600 });
  writeFileSync(join(flair, "backups", "memories.json"), "{\"n\":1}\n");
  writeFileSync(join(flair, "logs", "rem-nightly.stderr.log"), "log\n");
  writeFileSync(join(flair, "upgrade-snapshots", "keep.txt"), "snap\n");
  const remShim = join(flair, "bin", "flair-rem-nightly");
  writeFileSync(remShim, "#!/bin/sh\necho shim\n", { mode: 0o700 });
  const remTimer = join(isoHome, ".config", "systemd", "user", REM_TIMER);
  const remService = join(isoHome, ".config", "systemd", "user", REM_SERVICE);
  writeFileSync(remTimer, "[Timer]\nOnCalendar=*-*-* 03:00\n");
  writeFileSync(remService, "[Service]\nExecStart=/bin/true\n");
  const remPlist = join(isoHome, "Library", "LaunchAgents", `${REM_LAUNCHD_LABEL}.plist`);
  writeFileSync(remPlist, "<?xml version=\"1.0\"?>\n");
  writeFileSync(join(isoHome, ".config", "systemd", "user", FED_TIMER), "[Timer]\n");
  writeFileSync(join(isoHome, ".config", "systemd", "user", FED_SERVICE), "[Service]\n");
  writeFileSync(join(isoHome, "Library", "LaunchAgents", `${FED_LAUNCHD_LABEL}.plist`), "<?xml version=\"1.0\"?>\n");
  writeFileSync(join(flair, "bin", "flair-federation-sync"), "#!/bin/sh\n", { mode: 0o700 });

  const dataMarker = join(flair, "data", "DO-NOT-SURVIVE");
  const keysMarker = join(flair, "keys", "agent.key");
  writeFileSync(dataMarker, "user data\n");
  writeFileSync(keysMarker, "ed25519\n");
  // Unique port so a leftover listener on 19926 cannot skip the purge.
  writeFileSync(join(flair, "config.yaml"), "port: 61926\n");

  wireClaudeCode(ENV);
  wireCodex(ENV);
  wireGemini(ENV);
  wireCursor(ENV);
  writeFileSync(join(isoHome, ".codex", "config.toml"),
    appendCodexFlairBlock("[other]\nkey = 1\n", ENV));
  // Sibling MCP server in Claude's JSON so unwire must preserve it.
  const claudeJson = join(isoHome, ".claude.json");
  writeFileSync(claudeJson, JSON.stringify({
    mcpServers: {
      flair: { command: "npx", args: ["-y", "@tpsdev-ai/flair-mcp"] },
      other: { command: "keep-me" },
    },
    theme: "dark",
  }, null, 2) + "\n");

  const hook = installHook({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
  expect(hook.ok).toBe(true);
  const continuity = installContinuityHooks({ homeDir: isoHome, harness: "claude-code", agentId: AGENT, flairUrl: URL });
  expect(continuity.ok).toBe(true);

  return {
    adminPass,
    backups: join(flair, "backups"),
    logs: join(flair, "logs"),
    snapshots: join(flair, "upgrade-snapshots"),
    remShim,
    remTimer,
    remService,
    remPlist,
    claudeJson,
    codexToml: join(isoHome, ".codex", "config.toml"),
    dataMarker,
    keysMarker,
  };
}

describe("removeCodexFlairBlock", () => {
  test("drops the flair table and keeps siblings", () => {
    const raw = appendCodexFlairBlock("[other]\nkey = 1\n", ENV);
    expect(codexConfigHasFlairSection(raw)).toBe(true);
    const next = removeCodexFlairBlock(raw);
    expect(codexConfigHasFlairSection(next)).toBe(false);
    expect(next).toContain("[other]");
    expect(next).toContain("key = 1");
    expect(next).not.toContain("mcp_servers.flair");
  });

  test("empty result when the file was only Flair", () => {
    const raw = appendCodexFlairBlock("", ENV);
    expect(removeCodexFlairBlock(raw)).toBe("");
  });
});

describe("purgeFlairInstall completeness (flair#853)", () => {
  test("every ALL_CLIENTS entry can unwire", () => {
    for (const client of ALL_CLIENTS) {
      expect(typeof client.unwire).toBe("function");
    }
  });

  test("removes admin-pass, extra ~/.flair trees, rem shim, scheduler units, and MCP/hook wiring", () => {
    const planted = plantIssue853Leftovers();

    const result = purgeFlairInstall({ homeDir: isoHome, skipSchedulerUnload: true });
    expect(purgeHadFailures(result)).toBe(false);

    expect(existsSync(planted.adminPass)).toBe(false);
    expect(existsSync(planted.backups)).toBe(false);
    expect(existsSync(planted.logs)).toBe(false);
    expect(existsSync(planted.snapshots)).toBe(false);
    expect(existsSync(planted.remShim)).toBe(false);
    expect(existsSync(planted.remTimer)).toBe(false);
    expect(existsSync(planted.remService)).toBe(false);
    expect(existsSync(planted.remPlist)).toBe(false);
    expect(existsSync(join(isoHome, ".flair"))).toBe(false);
    expect(existsSync(planted.dataMarker)).toBe(false);
    expect(existsSync(planted.keysMarker)).toBe(false);
    expect(existsSync(join(isoHome, ".config", "systemd", "user", FED_TIMER))).toBe(false);
    expect(existsSync(join(isoHome, ".config", "systemd", "user", FED_SERVICE))).toBe(false);

    const claude = JSON.parse(readFileSync(planted.claudeJson, "utf-8"));
    expect(claude.mcpServers.flair).toBeUndefined();
    expect(claude.mcpServers.other).toEqual({ command: "keep-me" });
    expect(claude.theme).toBe("dark");

    const toml = readFileSync(planted.codexToml, "utf-8");
    expect(codexConfigHasFlairSection(toml)).toBe(false);
    expect(toml).toContain("[other]");

    const gemini = JSON.parse(readFileSync(join(isoHome, ".gemini", "settings.json"), "utf-8"));
    expect(gemini.mcpServers?.flair).toBeUndefined();

    const hookPath = hookSettingsPath(isoHome, "claude-code");
    const hookRaw = readFileSync(hookPath, "utf-8");
    expect(hookRaw).not.toContain("flair-mcp");

    const npmLeft = result.leftovers.find((l) => l.path === FLAIR_NPM_PACKAGE);
    expect(npmLeft).toBeDefined();
    expect(npmLeft?.kind).toBe("intentional");
    expect(npmLeft?.remedy).toContain("npm uninstall -g");
  });

  test("never claims fully purged while the npm package is intentionally left", () => {
    plantIssue853Leftovers();
    const result = purgeFlairInstall({ homeDir: isoHome, skipSchedulerUnload: true });
    const report = formatPurgeReport(result);
    expect(report.claimedFullyPurged).toBe(false);
    expect(report.lines.join("\n")).not.toContain("Flair fully purged");
    expect(report.lines.join("\n")).toContain("Intentionally left:");
    expect(report.lines.join("\n")).toContain(FLAIR_NPM_PACKAGE);
  });

  test("claims fully purged only when nothing remains", () => {
    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });
    const report = formatPurgeReport(result);
    expect(report.claimedFullyPurged).toBe(true);
    expect(report.lines.join("\n")).toContain("Flair fully purged");
    expect(purgeHadFailures(result)).toBe(false);
  });
});

describe("flair uninstall --purge CLI (flair#853)", () => {
  async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const shimBin = mkdtempSync(join(tmpdir(), "flair-purge-shim-"));
    writeFileSync(join(shimBin, "launchctl"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(shimBin, "systemctl"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: isoHome,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    };
    delete env.FLAIR_URL;
    delete env.FLAIR_TARGET;
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    rmSync(shimBin, { recursive: true, force: true });
    return { stdout, stderr, exitCode };
  }

  test("CLI purge removes issue leftovers and lists the npm package", async () => {
    const planted = plantIssue853Leftovers();
    const { stdout, stderr, exitCode } = await runCli(["uninstall", "--purge"]);
    const out = stdout + stderr;

    expect(exitCode).toBe(0);
    expect(existsSync(planted.adminPass)).toBe(false);
    expect(existsSync(planted.remShim)).toBe(false);
    expect(existsSync(planted.remTimer)).toBe(false);
    expect(existsSync(planted.remService)).toBe(false);
    expect(existsSync(join(isoHome, ".flair"))).toBe(false);
    expect(codexConfigHasFlairSection(readFileSync(planted.codexToml, "utf-8"))).toBe(false);
    const claude = JSON.parse(readFileSync(planted.claudeJson, "utf-8"));
    expect(claude.mcpServers.flair).toBeUndefined();

    expect(out).toContain("Intentionally left:");
    expect(out).toContain(FLAIR_NPM_PACKAGE);
    expect(out).not.toContain("Flair fully purged");
  }, 30_000);
});
