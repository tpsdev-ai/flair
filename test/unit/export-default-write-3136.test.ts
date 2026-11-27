/**
 * flair#3136: `flair export`'s default output stays inside the resolved exports
 * directory, and a failed write removes the file that run created. Real CLI,
 * real files, a sandboxed HOME; fetch is the only stand-in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";
import { tempDir } from "../helpers/temp-dir.js";

const CHILD_DEADLINE_MS = 20_000;
const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
const CLI_PATH = join(ROOT, "dist", "cli.js");
const FETCH_PRELOAD = pathToFileURL(join(ROOT, "test", "fixtures", "export-fetch-1970.cjs")).href;
const WRITE_FAIL_PRELOAD = pathToFileURL(join(ROOT, "test", "fixtures", "export-write-fail-3136.mjs")).href;
const EXPORT_MODULE = join(ROOT, "dist", "commands", "export.js");
const CLOCK_MS = 1764200000000;
const AGENT = "agent-a";
const URL = "http://example.test";

interface RunResult { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], home: string, preloads: string[] = [FETCH_PRELOAD]): Promise<RunResult> {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const env = {
    ...ambient,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    FLAIR_TEST_EXPORT_CLOCK_MS: String(CLOCK_MS),
    MOCK_AGENT_STATUS: "200",
    MOCK_AGENT_ID: AGENT,
    MOCK_PATH_LOG: join(home, "requests.log"),
    MOCK_EXPORT_MODULE: EXPORT_MODULE,
  } as Record<string, string>;
  writeFileSync(env.MOCK_PATH_LOG, "");
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(nodeBin({ env }), [...preloads.flatMap((p) => ["--import", p]), CLI_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000, // literal for the spawn-budget gate
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

const exportArgs = (home: string, extra: string[] = []): string[] => [
  "export", AGENT, "--url", URL, "--admin-pass", "test-pass-3136", "--keys-dir", join(home, "keys"), ...extra,
];

const defaultPath = (home: string): string => join(home, ".flair", "exports", `${AGENT}-${CLOCK_MS}.json`);

beforeAll(() => {
  ensureCliBuild();
}, 120_000);

describe("flair export: default output inside the resolved exports directory (#3136)", () => {
  test("a symlinked exports directory outside HOME is refused and nothing is written", async () => {
    const home = tempDir("flair-3136-write-home-");
    const target = tempDir("flair-3136-write-target-");
    mkdirSync(join(home, ".flair"), { recursive: true });
    symlinkSync(target, join(home, ".flair", "exports"));

    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("outside the exports directory");
    expect(readdirSync(target)).toEqual([]);
  }, 60_000);

  test("a plain exports directory receives the default export", async () => {
    const home = tempDir("flair-3136-write-home-");
    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(defaultPath(home), "utf8"))).toMatchObject({ type: "agent-export", agent: { id: AGENT } });
  }, 60_000);

  test("--output writes at the operator's path through the symlinked exports directory", async () => {
    const home = tempDir("flair-3136-write-home-");
    const target = tempDir("flair-3136-write-target-");
    mkdirSync(join(home, ".flair"), { recursive: true });
    symlinkSync(target, join(home, ".flair", "exports"));
    const explicit = join(target, "explicit.json");

    const result = await runCli(exportArgs(home, ["--output", explicit]), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(explicit, "utf8")).agent.id).toBe(AGENT);
  }, 60_000);

  test("a failed write after the exclusive create leaves no file and the next run succeeds", async () => {
    const home = tempDir("flair-3136-write-home-");
    const exportsDir = join(home, ".flair", "exports");

    const first = await runCli(exportArgs(home), home, [FETCH_PRELOAD, WRITE_FAIL_PRELOAD]);
    expect(first.code, `${first.stdout}${first.stderr}`).not.toBe(0);
    expect(readdirSync(exportsDir)).toEqual([]);

    const second = await runCli(exportArgs(home), home);
    expect(second.code, `${second.stdout}${second.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(defaultPath(home), "utf8")).agent.id).toBe(AGENT);
  }, 120_000);
});
