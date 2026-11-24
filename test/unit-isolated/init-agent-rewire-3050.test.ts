import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { nodeBin } from "../helpers/node-runtime.ts";
import { tempDir } from "../helpers/temp-dir.ts";

/**
 * flair#3050 — two built-CLI init runs rewire the fixture's Claude Code and
 * Codex configs and hooks to the second agent.
 *
 * HOME-isolated: the fixture HOME is a temp dir and inherited Flair/Harper
 * env vars are dropped, so a real ~/.claude.json or ~/.codex/config.toml is
 * never read or written; the fixture supplies its own FLAIR_ADMIN_PASS
 * credential. `--skip-start` plus a pre-seeded harper-config.yaml keeps
 * the run to local config writes (no Harper install, start, or network call).
 */

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "dist", "cli.js");
const HTTP_PORT = "20991";
const OPS_PORT = "20990";
const ADMIN_PASS = "codex-rewire-fixture-pass";

interface Fixture {
  home: string;
}

function fixture(): Fixture {
  const home = tempDir("f3050-");
  const dataDir = join(home, ".flair", "data");
  mkdirSync(dataDir, { recursive: true });
  // Mark the instance installed so --skip-start neither installs nor starts Harper.
  writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
  // Both clients detected by their config path (no binary lookup needed).
  writeFileSync(join(home, ".claude.json"), "{}\n");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "");
  return { home };
}

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$|NODE_OPTIONS$)/.test(key)) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.NO_COLOR = "1";
  env.FLAIR_ADMIN_PASS = ADMIN_PASS;
  return env;
}

function runInit(home: string, agent: string) {
  const env = childEnv(home);
  return spawnSync(
    nodeBin({ env }),
    [
      CLI, "init", "--skip-start",
      "--agent", agent,
      "--client", "all",
      "--skip-soul", "--skip-smoke", "--skip-claude-md",
      "--port", HTTP_PORT, "--ops-port", OPS_PORT,
    ],
    {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 45_000,
      killSignal: "SIGKILL",
    },
  );
}

function claudeAgent(home: string): string | undefined {
  const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  return config.mcpServers?.flair?.env?.FLAIR_AGENT_ID;
}

function codexAgent(home: string): string | undefined {
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
  return toml.match(/^FLAIR_AGENT_ID\s*=\s*"([^"]*)"/m)?.[1];
}

function hookAgent(home: string, settingsPath: string): string | undefined {
  const config = JSON.parse(readFileSync(settingsPath, "utf-8"));
  const commands = (config.hooks?.SessionStart ?? []).flatMap((group: any) =>
    (group?.hooks ?? []).map((hook: any) => hook?.command)
  );
  const command = commands.find(
    (value: unknown) => typeof value === "string" && value.includes("flair-session-start"),
  );
  return typeof command === "string" ? command.match(/FLAIR_AGENT_ID=([^\s'"]+)/)?.[1] : undefined;
}

function claudeHookAgent(home: string): string | undefined {
  return hookAgent(home, join(home, ".claude", "settings.json"));
}

function codexHookAgent(home: string): string | undefined {
  return hookAgent(home, join(home, ".codex", "hooks.json"));
}

test("a second init with a new agent rewires both Claude Code and Codex", () => {
  const { home } = fixture();

  const first = runInit(home, "agent-a");
  expect(first.error).toBeUndefined();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(claudeAgent(home)).toBe("agent-a");
  expect(codexAgent(home)).toBe("agent-a");
  expect(claudeHookAgent(home)).toBe("agent-a");
  expect(codexHookAgent(home)).toBe("agent-a");

  const second = runInit(home, "agent-b");
  expect(second.error).toBeUndefined();
  expect(second.status, second.stdout + second.stderr).toBe(0);
  // Both clients were rewritten in this run — Codex is not a pin-only no-op.
  expect(second.stdout).toContain("Codex: wired ~/.codex/config.toml");
  expect(second.stdout).not.toContain("Codex: already wired");
  // Both SessionStart hooks moved with the clients; a presence-only no-op
  // would leave them bootstrapping the first agent.
  expect(second.stdout).toContain("re-pointed the SessionStart hook");
  expect(claudeAgent(home)).toBe("agent-b");
  expect(codexAgent(home)).toBe("agent-b");
  expect(claudeHookAgent(home)).toBe("agent-b");
  expect(codexHookAgent(home)).toBe("agent-b");
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
  expect(toml).not.toContain('FLAIR_AGENT_ID = "agent-a"');
  expect(toml.match(/^FLAIR_AGENT_ID/gm)?.length).toBe(1);
}, 90_000);

beforeAll(() => ensureCliBuild(), 120_000);

test("init runs through runInit when the parent's NODE_OPTIONS names a missing preload", () => {
  const { home } = fixture();
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${join(tempDir("f3050-preload-"), "missing-preload.cjs")}`;
  try {
    const run = runInit(home, "agent-a");
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(claudeAgent(home)).toBe("agent-a");
    expect(codexAgent(home)).toBe("agent-a");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
}, 90_000);


test("init fixture drops inherited deployment variables and supplies its credential", () => {
  const previous = process.env.FLAIR_INHERITED_FIXTURE;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.FLAIR_INHERITED_FIXTURE = "inherited";
  // Node exits at startup when NODE_OPTIONS names a missing --require preload.
  process.env.NODE_OPTIONS = `--require=${join(tempDir("f3050-preload-"), "missing-preload.cjs")}`;
  try {
    const env = childEnv("fixture-home");
    expect(() => nodeBin({ env })).not.toThrow();
    expect(env.FLAIR_INHERITED_FIXTURE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.FLAIR_ADMIN_PASS).toBe(ADMIN_PASS);
  } finally {
    if (previous === undefined) delete process.env.FLAIR_INHERITED_FIXTURE;
    else process.env.FLAIR_INHERITED_FIXTURE = previous;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
}, 30_000);
