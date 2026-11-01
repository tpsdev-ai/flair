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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  wireClaudeCode,
  wireCodex,
  wireGemini,
  wireCursor,
  wireAntigravity,
  wirePi,
  ALL_CLIENTS,
  clientConfigBackupPath,
  clientConfigHasFlairEntry,
  piSettingsPath,
  piPackageEntrySource,
  isPiFlairNpmSource,
  removeCodexFlairBlock,
  appendCodexFlairBlock,
  codexConfigHasFlairSection,
} from "../../src/install/clients.ts";
import { installHook, installContinuityHooks, hookSettingsPath, hookBackupPath } from "../../src/hook-install.ts";
import { withHome } from "../../src/lib/home.ts";
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
let prevPiDir: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-purge-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
  // The sandbox preload points pi at its own temp dir; drop it so pi resolves
  // under this test's HOME, like every other client config.
  prevPiDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
  else delete process.env.PI_CODING_AGENT_DIR;
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
  claudeHookBak: string;
  codexHookBak: string;
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
  const codexHook = installHook({ homeDir: isoHome, harness: "codex", agentId: AGENT, flairUrl: URL });
  expect(codexHook.ok).toBe(true);

  // Pre-existing sibling backups — uninstallHook overwrites these even on a
  // later no-op; purge must delete them (flair#853 Bugbot).
  const claudeHookBak = hookBackupPath(hookSettingsPath(isoHome, "claude-code"));
  const codexHookBak = hookBackupPath(hookSettingsPath(isoHome, "codex"));
  writeFileSync(claudeHookBak, "{\"preexisting\":\"claude-bak\"}\n");
  writeFileSync(codexHookBak, "{\"preexisting\":\"codex-bak\"}\n");

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
    claudeHookBak,
    codexHookBak,
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
    expect(existsSync(planted.claudeHookBak)).toBe(false);
    expect(existsSync(planted.codexHookBak)).toBe(false);
    expect(existsSync(hookBackupPath(hookSettingsPath(isoHome, "claude-code")))).toBe(false);
    expect(existsSync(hookBackupPath(hookSettingsPath(isoHome, "codex")))).toBe(false);

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

  test("does not leave hook .bak files after a no-op uninstall (flair#853 Bugbot)", () => {
    const claudeSettings = hookSettingsPath(isoHome, "claude-code");
    const codexSettings = hookSettingsPath(isoHome, "codex");
    mkdirSync(join(isoHome, ".claude"), { recursive: true });
    mkdirSync(join(isoHome, ".codex"), { recursive: true });
    writeFileSync(claudeSettings, JSON.stringify({ theme: "dark" }, null, 2) + "\n");
    writeFileSync(codexSettings, JSON.stringify({ model: "gpt" }, null, 2) + "\n");
    const claudeBak = hookBackupPath(claudeSettings);
    const codexBak = hookBackupPath(codexSettings);
    writeFileSync(claudeBak, "{\"preexisting\":\"claude\"}\n");
    writeFileSync(codexBak, "{\"preexisting\":\"codex\"}\n");

    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });
    expect(purgeHadFailures(result)).toBe(false);
    expect(existsSync(claudeBak)).toBe(false);
    expect(existsSync(codexBak)).toBe(false);
    expect(JSON.parse(readFileSync(claudeSettings, "utf-8")).theme).toBe("dark");
    expect(JSON.parse(readFileSync(codexSettings, "utf-8")).model).toBe("gpt");
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
    expect(existsSync(planted.claudeHookBak)).toBe(false);
    expect(existsSync(planted.codexHookBak)).toBe(false);
    expect(codexConfigHasFlairSection(readFileSync(planted.codexToml, "utf-8"))).toBe(false);
    const claude = JSON.parse(readFileSync(planted.claudeJson, "utf-8"));
    expect(claude.mcpServers.flair).toBeUndefined();

    expect(out).toContain("Intentionally left:");
    expect(out).toContain(FLAIR_NPM_PACKAGE);
    expect(out).not.toContain("Flair fully purged");
  }, 30_000);

  /**
   * flair#2886: a home wired for Claude Code, Codex and pi through the real
   * client modules, with settings Flair does not own in every active config.
   */
  function seedWiredHome(home: string = isoHome) {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "keep-me" } },
    }, null, 2) + "\n");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[other]\nmodel = \"gpt-5\"\n");
    const pi = withHome(home, () => piSettingsPath());
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(pi, JSON.stringify({
      theme: "light",
      packages: [{ source: "npm:some-other-package@1.0.0" }],
      extensions: [],
    }, null, 2) + "\n");
    const wired = withHome(home, () => [wireClaudeCode(ENV), wireCodex(ENV), wirePi(ENV)]);
    for (const result of wired) {
      expect(result.ok).toBe(true);
    }
    return {
      claude: join(home, ".claude.json"),
      codex: join(home, ".codex", "config.toml"),
      pi,
    };
  }

  function snapshotConfigs(paths: { claude: string; codex: string; pi: string }) {
    return {
      claude: JSON.parse(readFileSync(paths.claude, "utf-8")),
      codex: readFileSync(paths.codex, "utf-8"),
      pi: JSON.parse(readFileSync(paths.pi, "utf-8")),
    };
  }

  const CLIENT_BACKUP_PATHS = [
    "~/.claude.json.bak",
    "~/.codex/config.toml.bak",
    "~/.pi/agent/settings.json.bak",
  ];

  /** A `.bak` that still carries Flair wiring, as an earlier unwire leaves it. */
  function writeWiredBackups(paths: { claude: string; codex: string; pi: string }) {
    writeFileSync(`${paths.claude}.bak`, readFileSync(paths.claude));
    writeFileSync(`${paths.codex}.bak`, readFileSync(paths.codex));
    writeFileSync(`${paths.pi}.bak`, readFileSync(paths.pi));
  }

  test("purge removes client-config backups with a Flair entry and keeps unrelated settings", async () => {
    const paths = seedWiredHome();
    const before = snapshotConfigs(paths);
    writeWiredBackups(paths);
    // A sibling backup that predates this purge and still carries old wiring.
    mkdirSync(join(isoHome, ".gemini"), { recursive: true });
    const geminiBak = clientConfigBackupPath("gemini");
    writeFileSync(geminiBak, JSON.stringify({
      mcpServers: { flair: { command: "npx", args: ["-y", "@tpsdev-ai/flair-mcp"] } },
    }, null, 2) + "\n");

    const { stdout, stderr, exitCode } = await runCli(["uninstall", "--purge"]);
    const out = stdout + stderr;
    expect(exitCode).toBe(0);

    for (const backup of [
      clientConfigBackupPath("claude-code"),
      clientConfigBackupPath("codex"),
      clientConfigBackupPath("pi"),
      geminiBak,
    ]) {
      expect(existsSync(backup), backup).toBe(false);
    }
    for (const reported of [...CLIENT_BACKUP_PATHS, "~/.gemini/settings.json.bak"]) {
      expect(out).toContain(`Removed: ${reported}`);
    }

    const after = snapshotConfigs(paths);
    const claudeExpected = structuredClone(before.claude);
    delete claudeExpected.mcpServers.flair;
    expect(after.claude).toEqual(claudeExpected);
    expect(after.codex).toBe(removeCodexFlairBlock(before.codex));
    const piExpected = structuredClone(before.pi);
    piExpected.packages = piExpected.packages.filter((entry: unknown) => {
      const source = piPackageEntrySource(entry);
      return !(source && isPiFlairNpmSource(source));
    });
    piExpected.extensions = piExpected.extensions.filter((entry: unknown) =>
      !(typeof entry === "string" && isPiFlairNpmSource(entry)));
    expect(after.pi).toEqual(piExpected);
  }, 30_000);

  test("a clean backup beside an existing active config survives unwiring byte-identical", () => {
    const paths = seedWiredHome();
    // The user's own copy, written before Flair ever ran: unwiring rewrites
    // `.claude.json` and its snapshot write lands on this same path.
    const ownBak = clientConfigBackupPath("claude-code");
    const ownBytes = JSON.stringify({ theme: "solarized" }, null, 2) + "\n";
    writeFileSync(ownBak, ownBytes);

    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });

    expect(purgeHadFailures(result)).toBe(false);
    expect(readFileSync(ownBak, "utf-8")).toBe(ownBytes);
    expect(result.removed).not.toContain("~/.claude.json.bak");
    expect(result.leftovers.some((l) => l.path === "~/.claude.json.bak")).toBe(false);
    // The active config itself was unwired, so the backup above was restored
    // over a snapshot the unwire did write.
    expect(JSON.parse(readFileSync(paths.claude, "utf-8")).mcpServers.flair).toBeUndefined();
  }, 30_000);

  test("purge sweeps the backups under homeDir, not the caller's HOME", () => {
    const target = mkdtempSync(join(tmpdir(), "flair-purge-target-"));
    const callerHome = mkdtempSync(join(tmpdir(), "flair-purge-caller-"));
    try {
      const targetPaths = seedWiredHome(target);
      const callerPaths = seedWiredHome(callerHome);
      writeWiredBackups(targetPaths);
      writeWiredBackups(callerPaths);
      const targetBak = withHome(target, () => clientConfigBackupPath("claude-code"));
      const callerBak = withHome(callerHome, () => clientConfigBackupPath("claude-code"));
      const callerBakBytes = readFileSync(callerBak);
      const callerConfigBytes = readFileSync(join(callerHome, ".claude.json"));
      expect(readFileSync(targetBak).includes("flair")).toBe(true);

      process.env.HOME = callerHome;
      const result = purgeFlairInstall({
        homeDir: target,
        skipSchedulerUnload: true,
        omitNpmLeftover: true,
      });

      expect(result.removed).toContain("~/.claude.json.bak");
      expect(existsSync(targetBak)).toBe(false);
      expect(Buffer.compare(readFileSync(callerBak), callerBakBytes)).toBe(0);
      expect(Buffer.compare(readFileSync(join(callerHome, ".claude.json")), callerConfigBytes)).toBe(0);
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(callerHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a pi backup pointing inside the pi-flair package is removed", () => {
    mkdirSync(join(isoHome, ".pi", "agent"), { recursive: true });
    const bak = clientConfigBackupPath("pi");
    writeFileSync(bak, JSON.stringify({
      extensions: ["~/.pi/agent/npm/node_modules/@tpsdev-ai/pi-flair/dist/index.js"],
    }, null, 2) + "\n");

    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });

    expect(result.removed).toContain("~/.pi/agent/settings.json.bak");
    expect(existsSync(bak)).toBe(false);
  }, 30_000);

  test("a pi backup whose path only contains pi-flair is left and reported as not checked", () => {
    mkdirSync(join(isoHome, ".pi", "agent"), { recursive: true });
    const bak = clientConfigBackupPath("pi");
    const bakBytes = JSON.stringify({ extensions: ["~/dist/pi-flair-notes.js"] }, null, 2) + "\n";
    writeFileSync(bak, bakBytes);

    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });

    expect(readFileSync(bak, "utf-8")).toBe(bakBytes);
    expect(result.removed).not.toContain("~/.pi/agent/settings.json.bak");
    expect(result.leftovers.filter((l) => l.kind === "unverified").map((l) => l.path))
      .toContain("~/.pi/agent/settings.json.bak");
    expect(purgeHadFailures(result)).toBe(true);
  }, 30_000);

  test("an unreadable or unparseable client backup is reported as not checked and left", () => {
    // A dangling symlink fails the read for every uid, root included.
    mkdirSync(join(isoHome, ".cursor"), { recursive: true });
    const linkBak = clientConfigBackupPath("cursor");
    symlinkSync(join(isoHome, "gone.json"), linkBak);
    mkdirSync(join(isoHome, ".gemini"), { recursive: true });
    const badBak = clientConfigBackupPath("gemini");
    const badBytes = "{ not json\n";
    writeFileSync(badBak, badBytes);

    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });

    expect(purgeHadFailures(result)).toBe(true);
    const unverified = result.leftovers.filter((l) => l.kind === "unverified").map((l) => l.path);
    expect(unverified).toContain("~/.cursor/mcp.json.bak");
    expect(unverified).toContain("~/.gemini/settings.json.bak");
    expect(result.removed).not.toContain("~/.cursor/mcp.json.bak");
    expect(result.removed).not.toContain("~/.gemini/settings.json.bak");
    expect(lstatSync(linkBak).isSymbolicLink()).toBe(true);
    expect(readFileSync(badBak, "utf-8")).toBe(badBytes);

    const report = formatPurgeReport(result);
    expect(report.lines.join("\n")).toContain("Not checked: ~/.cursor/mcp.json.bak");
    expect(report.claimedFullyPurged).toBe(false);
  }, 30_000);

  test("pi lookalikes that are not Flair's own are left and reported as not checked", () => {
    mkdirSync(join(isoHome, ".pi", "agent"), { recursive: true });
    const bak = clientConfigBackupPath("pi");
    const lookalikes = [
      JSON.stringify({ extensions: ["~/work/pi-flair/notes.js"] }, null, 2) + "\n",
      JSON.stringify({ extensions: ["npm:@other/pi-flair"] }, null, 2) + "\n",
      JSON.stringify({ packages: ["npm:@other/pi-flair"] }, null, 2) + "\n",
    ];

    for (const bakBytes of lookalikes) {
      writeFileSync(bak, bakBytes);
      const result = purgeFlairInstall({
        homeDir: isoHome,
        skipSchedulerUnload: true,
        omitNpmLeftover: true,
      });
      expect(readFileSync(bak, "utf-8")).toBe(bakBytes);
      expect(result.removed).not.toContain("~/.pi/agent/settings.json.bak");
      expect(result.leftovers.filter((l) => l.kind === "unverified").map((l) => l.path))
        .toContain("~/.pi/agent/settings.json.bak");
    }
  }, 30_000);

  test("an undecidable pre-existing backup survives an unwire that rewrites the active config", () => {
    withHome(isoHome, () => {
      wireGemini(ENV);
      wireCursor(ENV);
      wireAntigravity(ENV);
    });

    // A dangling symlink: the read fails for every uid, root included.
    const cursorBak = clientConfigBackupPath("cursor");
    symlinkSync(join(isoHome, "gone.json"), cursorBak);
    // Unparseable JSON.
    const geminiBak = clientConfigBackupPath("gemini");
    const geminiBytes = "{ not json\n";
    writeFileSync(geminiBak, geminiBytes);
    // Unreadable for every uid: a directory in the file's place.
    const antigravityBak = clientConfigBackupPath("antigravity");
    mkdirSync(antigravityBak, { recursive: true });

    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });

    expect(purgeHadFailures(result)).toBe(true);
    const unverified = result.leftovers.filter((l) => l.kind === "unverified").map((l) => l.path);
    expect(unverified).toContain("~/.cursor/mcp.json.bak");
    expect(unverified).toContain("~/.gemini/settings.json.bak");
    expect(unverified).toContain("~/.gemini/config/mcp_config.json.bak");
    expect(result.removed).not.toContain("~/.cursor/mcp.json.bak");
    expect(result.removed).not.toContain("~/.gemini/settings.json.bak");
    expect(result.removed).not.toContain("~/.gemini/config/mcp_config.json.bak");

    expect(lstatSync(cursorBak).isSymbolicLink()).toBe(true);
    expect(readFileSync(geminiBak, "utf-8")).toBe(geminiBytes);
    expect(lstatSync(antigravityBak).isDirectory()).toBe(true);

    // The active configs were rewritten, so these backups were held across a
    // write that would otherwise have replaced them.
    for (const path of [
      join(isoHome, ".cursor", "mcp.json"),
      join(isoHome, ".gemini", "settings.json"),
      join(isoHome, ".gemini", "config", "mcp_config.json"),
    ]) {
      expect(JSON.parse(readFileSync(path, "utf-8")).mcpServers?.flair).toBeUndefined();
    }
  }, 30_000);

  test("a JSON null client backup is not checked, not treated as absent", () => {
    expect(clientConfigHasFlairEntry("gemini", Buffer.from("null\n"), "x").status).toBe("unknown");
    mkdirSync(join(isoHome, ".gemini"), { recursive: true });
    const bak = clientConfigBackupPath("gemini");
    writeFileSync(bak, "null\n");

    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });

    expect(readFileSync(bak, "utf-8")).toBe("null\n");
    expect(result.leftovers.filter((l) => l.kind === "unverified").map((l) => l.path))
      .toContain("~/.gemini/settings.json.bak");
  }, 30_000);

  test("purging a different home resolves pi there and ignores PI_CODING_AGENT_DIR", () => {
    const target = mkdtempSync(join(tmpdir(), "flair-purge-pi-target-"));
    const callerHome = mkdtempSync(join(tmpdir(), "flair-purge-pi-caller-"));
    try {
      seedWiredHome(target);
      const callerPiDir = join(callerHome, "caller-pi");
      mkdirSync(callerPiDir, { recursive: true });
      const callerPi = join(callerPiDir, "settings.json");
      const callerBytes = JSON.stringify({ packages: ["npm:@tpsdev-ai/pi-flair@9.9.9"] }, null, 2) + "\n";
      writeFileSync(callerPi, callerBytes);

      process.env.HOME = callerHome;
      process.env.PI_CODING_AGENT_DIR = callerPiDir;
      const result = purgeFlairInstall({
        homeDir: target,
        skipSchedulerUnload: true,
        omitNpmLeftover: true,
      });

      const targetPi = join(target, ".pi", "agent", "settings.json");
      expect(JSON.parse(readFileSync(targetPi, "utf-8")).packages)
        .toEqual([{ source: "npm:some-other-package@1.0.0" }]);
      expect(readFileSync(callerPi, "utf-8")).toBe(callerBytes);
      expect((result.notes ?? []).join("\n")).toContain("PI_CODING_AGENT_DIR");
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(callerHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("purging the same home still honours PI_CODING_AGENT_DIR", () => {
    const overrideDir = join(isoHome, "custom-pi-agent");
    mkdirSync(overrideDir, { recursive: true });
    const settings = join(overrideDir, "settings.json");
    writeFileSync(settings, JSON.stringify({
      packages: ["npm:@tpsdev-ai/pi-flair@9.9.9"],
      extensions: ["~/notes.js"],
    }, null, 2) + "\n");
    const bak = `${settings}.bak`;
    writeFileSync(bak, JSON.stringify({ packages: ["npm:@tpsdev-ai/pi-flair@9.9.9"] }, null, 2) + "\n");

    process.env.HOME = isoHome;
    process.env.PI_CODING_AGENT_DIR = overrideDir;
    const result = purgeFlairInstall({
      homeDir: isoHome,
      skipSchedulerUnload: true,
      omitNpmLeftover: true,
    });

    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ packages: [], extensions: ["~/notes.js"] });
    expect(existsSync(bak)).toBe(false);
    expect(result.notes ?? []).toEqual([]);
  }, 30_000);

  test("plain uninstall keeps every client-config backup", async () => {
    seedWiredHome();
    const backups = (["claude-code", "codex", "pi"] as const).map((id) => ({
      id,
      bytes: readFileSync(clientConfigBackupPath(id)),
    }));

    const { exitCode } = await runCli(["uninstall"]);
    expect(exitCode).toBe(0);

    for (const { id, bytes } of backups) {
      const after = readFileSync(clientConfigBackupPath(id));
      expect(Buffer.compare(after, bytes)).toBe(0);
    }
  }, 30_000);
});
