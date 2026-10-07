import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { program } from "../../src/cli.ts";
import * as render from "../../src/render.ts";
import { buildSessionStartHookCommand } from "../../src/doctor-client.ts";
import { hookSettingsPath, type Harness } from "../../src/hook-install.ts";
import { clientConfigPath } from "../../src/install/clients.ts";
import { runDoctorChecks } from "../../src/lib/doctor-run.ts";
import { withHome } from "../../src/lib/home.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const CASE_MS = 30_000;
const AGENT = "agent-a";
const INSTALLED = flairCliVersion();

function oneVersionBehind(version: string): string {
  const core = parseSemverCore(version);
  if (!core) throw new Error(`CLI version is not semver: ${version}`);
  const [maj, min, pat] = core;
  if (pat > 0) return `${maj}.${min}.${pat - 1}`;
  if (min > 0) return `${maj}.${min - 1}.0`;
  throw new Error(`cannot compute one version behind ${version}`);
}

const STALE = oneVersionBehind(INSTALLED);

function installerCommand(harness: Harness, agent: string, version: string): string {
  const env = harness === "codex" ? `FLAIR_HOOK_HARNESS=codex FLAIR_AGENT_ID=${agent}` : `FLAIR_AGENT_ID=${agent}`;
  const invocation = `${env} npx -y -p ${FLAIR_MCP_PACKAGE}@${version} flair-session-start`;
  return harness === "codex"
    ? `sh -c 'out=$(${invocation}) && printf %s "$out" || true'`
    : `sh -c 'out=$(${invocation} 2>/dev/null) && printf %s "$out" || true'`;
}

// ── sandbox ─────────────────────────────────────────────────────────────────

const STRIPPED_ENV = /^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$|TPS_)/;

let root: string;
let home: string;
let dataDir: string;
let keysDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  root = tempDir("flair-");
  home = join(root, "home");
  dataDir = process.platform === "darwin" && root.startsWith("/private/var/")
    ? root.slice("/private".length)
    : root;
  keysDir = join(root, "keys");
  const bin = join(root, "bin");
  for (const dir of [home, dataDir, keysDir, bin]) mkdirSync(dir, { recursive: true });
  // An existing install: init --skip-start then skips Harper's install step.
  writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
  for (const name of ["npx", "npm"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  for (const key of Object.keys(process.env)) if (STRIPPED_ENV.test(key)) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Run one registered command in-process; capture its console output and exit code. */
async function runCli(args: string[]): Promise<{ out: string; code: number }> {
  const orig = { exit: process.exit, log: console.log, error: console.error, warn: console.warn };
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  let out = "";
  const sink = (...parts: unknown[]): void => {
    out += parts.map((part) => String(part)).join(" ") + "\n";
  };
  console.log = sink;
  console.error = sink;
  console.warn = sink;
  process.exit = ((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as typeof process.exit;
  let code = 0;
  try {
    await program.parseAsync(["node", "flair", ...args]);
    code = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
    code = err.code;
  } finally {
    process.exit = orig.exit;
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
    process.exitCode = prevExitCode;
  }
  return { out, code };
}

function initArgs(harness: Harness, extra: string[] = []): string[] {
  return [
    "init", "--agent", AGENT, "--client", harness,
    "--skip-start", "--skip-soul", "--skip-smoke", "--skip-claude-md",
    "--data-dir", dataDir, "--keys-dir", keysDir, "--port", "19926", "--ops-port", "19925",
    ...extra,
  ];
}

const statusArgs = (harness: Harness): string[] => ["hook", "status", "--harness", harness];

function writeHookGroups(harness: Harness, groups: string[][]): string {
  const path = hookSettingsPath(home, harness);
  mkdirSync(join(path, ".."), { recursive: true });
  const SessionStart = groups.map((commands) => ({ hooks: commands.map((command) => ({ type: "command", command })) }));
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart } }, null, 2) + "\n");
  return path;
}

function hookCommands(harness: Harness): string[] {
  const cfg = JSON.parse(readFileSync(hookSettingsPath(home, harness), "utf-8"));
  return (cfg.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));
}

const HARNESSES: readonly Harness[] = ["claude-code", "codex"];

describe("flair#2291 — fixtures are the installer form", () => {
  it("installerCommand at the installed version is what the builder writes", () => {
    for (const harness of HARNESSES) {
      expect(installerCommand(harness, AGENT, INSTALLED)).toBe(buildSessionStartHookCommand(AGENT, undefined, { harness }));
    }
  });
});

describe("flair#2291 — the registered init and hook status actions on a stale hook", () => {
  for (const harness of HARNESSES) {
    it(`${harness}: hook status is red and exits 1; init re-pins; then status is not red and a second init changes no byte`, async () => {
      const path = writeHookGroups(harness, [[installerCommand(harness, AGENT, STALE)]]);

      const before = await runCli(statusArgs(harness));
      expect(before.code).toBe(1);
      expect(before.out).toContain(`${render.icons.error} SessionStart hook: command names older pin flair-mcp@${STALE} (installed CLI is ${INSTALLED})`);

      const init = await runCli(initArgs(harness));
      expect(init.code).toBe(0);
      expect(init.out).toContain(`re-pinned the SessionStart hook in ${path} to ${mcpServerSpec()}`);
      expect(hookCommands(harness)).toEqual([installerCommand(harness, AGENT, INSTALLED)]);

      const after = await runCli(statusArgs(harness));
      expect(after.code).toBe(0);
      expect(after.out).not.toContain("command names older pin");

      const bytes = readFileSync(path, "utf-8");
      const again = await runCli(initArgs(harness));
      expect(again.code).toBe(0);
      expect(again.out).toContain(`SessionStart hook already wired in ${path}`);
      expect(readFileSync(path, "utf-8")).toBe(bytes);
    }, CASE_MS);
  }
});

describe("flair#2291 — init --skip-hook writes no hook", () => {
  for (const harness of HARNESSES) {
    it(`${harness}: a stale hook file stays byte-identical`, async () => {
      const path = writeHookGroups(harness, [[installerCommand(harness, AGENT, STALE)]]);
      const bytes = readFileSync(path, "utf-8");
      const init = await runCli(initArgs(harness, ["--skip-hook"]));
      expect(init.code).toBe(0);
      expect(readFileSync(path, "utf-8")).toBe(bytes);
      expect(init.out).toContain(`SessionStart hook in ${path} not re-pinned (--skip-hook)`);
    }, CASE_MS);
  }
});

describe("flair#2291 — the finding reads the named pin span", () => {
  const DECOY_AGENT = `${AGENT}:${FLAIR_MCP_PACKAGE}@${INSTALLED}`;

  it("hook status reports the named stale pin; init re-pins and keeps the agent id", async () => {
    const command = installerCommand("claude-code", DECOY_AGENT, STALE);
    expect(command.indexOf(`${FLAIR_MCP_PACKAGE}@${INSTALLED}`)).toBeGreaterThan(-1);
    expect(command.indexOf(`${FLAIR_MCP_PACKAGE}@${INSTALLED}`)).toBeLessThan(command.indexOf(`${FLAIR_MCP_PACKAGE}@${STALE}`));
    const path = writeHookGroups("claude-code", [[command]]);

    const status = await runCli(statusArgs("claude-code"));
    expect(status.code).toBe(1);
    expect(status.out).toContain(`command names older pin flair-mcp@${STALE}`);

    const init = await runCli(initArgs("claude-code"));
    expect(init.out).toContain(`re-pinned the SessionStart hook in ${path}`);
    expect(hookCommands("claude-code")).toEqual([installerCommand("claude-code", DECOY_AGENT, INSTALLED)]);
  }, CASE_MS);

  it("the doctor catalog fails on the named stale pin", () => {
    writeClaudeMcp();
    writeHookGroups("claude-code", [[installerCommand("claude-code", DECOY_AGENT, STALE)]]);
    const hook = doctorHookCheck();
    expect(hook?.status).toBe("fail");
    expect(hook?.detail ?? "").toContain(`pinned to flair-mcp@${STALE}`);
  });
});

describe("flair#2291 — ambiguous hook shapes are held and reported", () => {
  // Silenced (`|| true`) like the installer form, so the catalog reaches its pin check.
  const twoInvocations = `sh -c 'out=$(${[
    `FLAIR_AGENT_ID=${AGENT} npx -y -p ${FLAIR_MCP_PACKAGE}@${INSTALLED} flair-session-start`,
    `FLAIR_AGENT_ID=${AGENT} npx -y -p ${FLAIR_MCP_PACKAGE}@${STALE} flair-session-start`,
  ].join("; ")} 2>/dev/null) && printf %s "$out" || true'`;
  const pinNoInvocation = `sh -c 'out=$(FLAIR_AGENT_ID=${AGENT} npx -y ${FLAIR_MCP_PACKAGE}@${STALE} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
  const shapes: ReadonlyArray<{ label: string; groups: () => string[][]; held: (path: string) => string }> = [
    {
      label: "two package spans in one command",
      groups: () => [[twoInvocations]],
      held: (path) => `2 \`npx -y -p\` spans in ${path} — pin not read, not re-pinned`,
    },
    {
      label: "an unrelated package and the current Flair pin in one command",
      groups: () => [[`npx -y -p other@1 other; ${installerCommand("claude-code", AGENT, INSTALLED)}`]],
      held: (path) => `2 \`npx -y -p\` spans in ${path} — pin not read, not re-pinned`,
    },
    {
      label: "a pin and no matching span",
      groups: () => [[pinNoInvocation]],
      held: (path) => `0 \`npx -y -p\` spans in ${path} — pin not read, not re-pinned`,
    },
    {
      label: "two matching hooks",
      groups: () => [
        [installerCommand("claude-code", AGENT, INSTALLED)],
        [installerCommand("claude-code", AGENT, STALE)],
      ],
      held: (path) => `2 Flair SessionStart hooks match in ${path} — pin not read, not re-pinned`,
    },
    {
      label: "two matching hooks, the first without the flair-mcp package",
      groups: () => [
        ["flair-session-start"],
        [installerCommand("claude-code", AGENT, STALE)],
      ],
      held: (path) => `2 Flair SessionStart hooks match in ${path} — pin not read, not re-pinned`,
    },
  ];

  for (const shape of shapes) {
    it(`${shape.label}: hook status reports the hold; init leaves the file byte-identical and reports it`, async () => {
      const path = writeHookGroups("claude-code", shape.groups());
      const display = path.replace(home, "~");
      const bytes = readFileSync(path, "utf-8");

      const status = await runCli(statusArgs("claude-code"));
      expect(status.out).toContain(`${render.icons.warn} SessionStart hook: ${shape.held(display)}`);
      expect(status.out).not.toContain("command names older pin");

      const init = await runCli(initArgs("claude-code"));
      expect(init.out).toContain(shape.held(display));
      expect(init.out).not.toContain("SessionStart hook already wired");
      expect(readFileSync(path, "utf-8")).toBe(bytes);
    }, CASE_MS);

    it(`${shape.label}: the doctor catalog warns with the hold`, () => {
      writeClaudeMcp();
      const path = writeHookGroups("claude-code", shape.groups());
      const hook = doctorHookCheck();
      expect(hook?.status).toBe("warn");
      expect(hook?.detail ?? "").toContain(shape.held(path.replace(home, "~")));
    });
  }
});

for (const harness of HARNESSES) {
  it(`${harness}: one unrelated package span reports no Flair invocation and preserves settings through status and init`, async () => {
    const command = `npx -y -p other@1 other; ${FLAIR_MCP_PACKAGE}@${STALE} flair-session-start`;
    const path = writeHookGroups(harness, [[command]]);
    const display = path.replace(home, "~");
    const bytes = readFileSync(path);
    const held = `No \`npx -y -p\` span invokes Flair in ${display} — pin not read, not re-pinned; use \`npx -y -p ${FLAIR_MCP_PACKAGE} flair-session-start\``;

    const status = await runCli(statusArgs(harness));
    expect(status.out).toContain(`${render.icons.warn} SessionStart hook: ${held}`);
    expect(readFileSync(path)).toEqual(bytes);

    const init = await runCli(initArgs(harness));
    expect(init.out).toContain(held);
    expect(readFileSync(path)).toEqual(bytes);
  }, CASE_MS);
}

it("quoted command text names an older pin; init leaves the file byte-identical", async () => {
  const command = `echo 'npx -y -p ${FLAIR_MCP_PACKAGE}@${STALE} flair-session-start'`;
  const path = writeHookGroups("claude-code", [[command]]);
  const bytes = readFileSync(path, "utf-8");
  const status = await runCli(statusArgs("claude-code"));
  expect(status.code).toBe(1);
  expect(status.out).toContain(`command names older pin flair-mcp@${STALE}`);
  const init = await runCli(initArgs("claude-code"));
  expect(init.out).toContain("not one of the installer forms Flair writes");
  expect(readFileSync(path, "utf-8")).toBe(bytes);
}, CASE_MS);

// ── doctor catalog helpers ──────────────────────────────────────────────────

function writeClaudeMcp(): void {
  const path = withHome(home, () => clientConfigPath("claude-code"));
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      flair: {
        command: "npx",
        args: ["-y", mcpServerSpec()],
        type: "stdio",
        env: { FLAIR_AGENT_ID: AGENT, FLAIR_URL: "http://127.0.0.1:19926" },
      },
    },
  }, null, 2) + "\n");
}

function doctorHookCheck() {
  const run = runDoctorChecks({
    homeDir: home,
    cwd: root,
    detectedClientIds: ["claude-code"],
    launchd: { state: "not-applicable" as const, detail: "not a launchd host" },
  });
  return run.results.find((r) => r.id === "session-start-hook");
}
