/**
 * flair#3136: `flair export` publishes its default output inside the resolved
 * exports directory via a temp file and a hard link. Real CLI, real files, a
 * sandboxed HOME; fetch is the only network stand-in. Every failure branch is
 * injected through the export module's write seam (`defaultExportWriteOps`), not
 * a global node:fs patch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";
import { tempDir } from "../helpers/temp-dir.js";

const CHILD_DEADLINE_MS = 20_000;
const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
const CLI_PATH = join(ROOT, "dist", "cli.js");
const FETCH_PRELOAD = pathToFileURL(join(ROOT, "test", "fixtures", "export-fetch-1970.cjs")).href;
const SEAM_PRELOAD = pathToFileURL(join(ROOT, "test", "fixtures", "export-seam-fail-3136.mjs")).href;
const EXPORT_MODULE = join(ROOT, "dist", "commands", "export.js");
const CLOCK_MS = 1764200000000;
const AGENT = "agent-a";
const URL = "http://example.test";

interface RunResult { code: number | null; stdout: string; stderr: string }

function runCli(
  args: string[],
  home: string,
  preloads: string[] = [FETCH_PRELOAD],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
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
    ...extraEnv,
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

/** The default export path under the REAL home (an ancestor may be a symlink). */
const defaultPathFor = (home: string): string => join(realpathSync(home), ".flair", "exports", `${AGENT}-${CLOCK_MS}.json`);

function keyMaterial(home: string): void {
  mkdirSync(join(home, "keys"), { recursive: true });
  writeFileSync(join(home, "keys", `${AGENT}.key`), "fixture-key-material\n");
}

async function expectSeamFailureLeavesNoFile(mode: string): Promise<void> {
  const home = tempDir("flair-3136-write-home-");
  const exportsDir = join(home, ".flair", "exports");
  const seamLog = join(home, "seam.log");
  writeFileSync(seamLog, "");

  const first = await runCli(exportArgs(home), home, [FETCH_PRELOAD, SEAM_PRELOAD], {
    MOCK_EXPORT_FAIL_MODE: mode,
    MOCK_EXPORT_SEAM_LOG: seamLog,
  });
  expect(first.code, `${first.stdout}${first.stderr}`).not.toBe(0);
  expect(readdirSync(exportsDir)).toEqual([]);
  expect(readFileSync(seamLog, "utf8")).toMatch(/^close \d+$/m);

  const second = await runCli(exportArgs(home), home);
  expect(second.code, `${second.stdout}${second.stderr}`).toBe(0);
  expect(JSON.parse(readFileSync(defaultPathFor(home), "utf8")).agent.id).toBe(AGENT);
}

beforeAll(() => {
  ensureCliBuild();
}, 120_000);

describe("flair export: the default output is published with a temp file and a hard link (#3136)", () => {
  test("a plain exports directory receives the default export under the real home", async () => {
    const home = tempDir("flair-3136-write-home-");
    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(defaultPathFor(home), "utf8"))).toMatchObject({ type: "agent-export", agent: { id: AGENT } });
  }, 60_000);

  test("a HOME reached through a symlinked ancestor receives the default export", async () => {
    const base = tempDir("flair-3136-write-ancestor-");
    const real = join(base, "real");
    mkdirSync(join(real, "home"), { recursive: true });
    symlinkSync(real, join(base, "link"));
    const home = join(base, "link", "home");

    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(defaultPathFor(home), "utf8")).agent.id).toBe(AGENT);
  }, 60_000);

  test("a symlinked .flair parent directory is refused and writes no export file", async () => {
    const home = tempDir("flair-3136-write-home-");
    const target = tempDir("flair-3136-write-target-");
    symlinkSync(target, join(home, ".flair"));

    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("outside the exports directory");
    expect(readdirSync(join(target, "exports"))).toEqual([]);
  }, 60_000);

  test("a symlinked exports directory is refused and writes no export file", async () => {
    const home = tempDir("flair-3136-write-home-");
    const target = tempDir("flair-3136-write-target-");
    mkdirSync(join(home, ".flair"), { recursive: true });
    symlinkSync(target, join(home, ".flair", "exports"));

    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("outside the exports directory");
    expect(readdirSync(target)).toEqual([]);
  }, 60_000);

  test("--output through a symlinked exports directory writes the file in the target without --include-key", async () => {
    const home = tempDir("flair-3136-write-home-");
    const target = tempDir("flair-3136-write-target-");
    mkdirSync(join(home, ".flair"), { recursive: true });
    symlinkSync(target, join(home, ".flair", "exports"));
    const explicit = join(home, ".flair", "exports", "explicit.json");

    const result = await runCli(exportArgs(home, ["--output", explicit]), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(join(target, "explicit.json"), "utf8")).agent.id).toBe(AGENT);
  }, 60_000);

  test("--output through a symlinked exports directory writes the file in the target with --include-key", async () => {
    const home = tempDir("flair-3136-write-home-");
    const target = tempDir("flair-3136-write-target-");
    mkdirSync(join(home, ".flair"), { recursive: true });
    symlinkSync(target, join(home, ".flair", "exports"));
    keyMaterial(home);
    const explicit = join(home, ".flair", "exports", "explicit.json");

    const result = await runCli(exportArgs(home, ["--output", explicit, "--include-key"]), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(join(target, "explicit.json"), "utf8")).privateKey).toBe("fixture-key-material");
  }, 60_000);

  test("an injected write failure through the module seam leaves no file and no temp, and the next run succeeds", async () => {
    await expectSeamFailureLeavesNoFile("write");
  }, 120_000);

  test("an injected fsync failure through the module seam leaves no file and no temp, and the next run succeeds", async () => {
    await expectSeamFailureLeavesNoFile("fsync");
  }, 120_000);

  test("an injected link failure through the module seam leaves no file and no temp, and the next run succeeds", async () => {
    await expectSeamFailureLeavesNoFile("link");
  }, 120_000);

  test("an injected temp-removal failure through the module seam reports the temp path in stderr", async () => {
    const home = tempDir("flair-3136-write-home-");
    const exportsDir = join(home, ".flair", "exports");
    const seamLog = join(home, "seam.log");
    writeFileSync(seamLog, "");

    const result = await runCli(exportArgs(home), home, [FETCH_PRELOAD, SEAM_PRELOAD], {
      MOCK_EXPORT_FAIL_MODE: "write+unlink",
      MOCK_EXPORT_SEAM_LOG: seamLog,
    });
    expect(result.code, `${result.stdout}${result.stderr}`).not.toBe(0);
    const unlinkLine = readFileSync(seamLog, "utf8").split("\n").find((line) => line.startsWith("unlink "));
    expect(unlinkLine).toBeDefined();
    const tempPath = unlinkLine!.slice("unlink ".length);
    expect(tempPath.startsWith(`${exportsDir}${sep}`)).toBe(true);
    expect(result.stderr).toContain(tempPath);
    expect(existsSync(defaultPathFor(home))).toBe(false);
  }, 60_000);

  test("a planted sentinel at the default name is refused through link EEXIST and survives byte-identical", async () => {
    const home = tempDir("flair-3136-write-home-");
    const planted = defaultPathFor(home);
    mkdirSync(join(planted, ".."), { recursive: true });
    writeFileSync(planted, "sentinel");

    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(planted);
    expect(readFileSync(planted, "utf8")).toBe("sentinel");
    expect(readdirSync(join(planted, ".."))).toEqual([`${AGENT}-${CLOCK_MS}.json`]);
  }, 60_000);
});
