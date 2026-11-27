/**
 * flair#3136: `flair export` applies the ONE agent-ID rule before any request
 * or file write, and its default output path stays a direct child of the
 * exports directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";
import { defaultExportOutputPath } from "../../src/commands/export.js";
import { invalidAgentIdMessage } from "../../src/lib/agent-id-rule.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const PRELOAD = join(import.meta.dirname ?? __dirname, "..", "fixtures", "export-fetch-1970.cjs");
const URL = "http://example.test";

interface CliResult { stdout: string; stderr: string; code: number | null; paths: string[] }
function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const logPath = join(cwd, "requests.log");
    writeFileSync(logPath, "");
    const startedAt = Date.now();
    const childEnv = { ...process.env, HOME: cwd, FLAIR_AGENT_ID: "", MOCK_PATH_LOG: logPath, ...env };
    const child = spawn(nodeBin({ env: childEnv, cwd }), ["--import", pathToFileURL(PRELOAD).href, CLI_PATH, ...args], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000, // literal for the spawn-budget gate
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
        return;
      }
      const paths = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      resolvePromise({ stdout, stderr, code, paths });
    });
  });
}

/** Every entry below `dir` (recursive), or [] when the directory is absent. */
function listTree(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }).map(String);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

describe("flair export: the agent-ID rule runs before any request or write (#3136)", () => {
  let scratch: string;
  beforeAll(() => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-export-3136-home-"));
  }, 120_000);
  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  for (const agentId of ["bad/id", ".."]) {
    test(`an id '${agentId}' is refused, sends no request and writes nothing`, async () => {
      const keysDir = join(scratch, `keys-${encodeURIComponent(agentId)}`);
      const exportsDir = join(scratch, ".flair", "exports");
      const { stdout, stderr, code, paths } = await runCli(
        ["export", agentId, "--url", URL, "--admin-pass", "test-pass-3136", "--keys-dir", keysDir],
        { MOCK_AGENT_STATUS: "200", MOCK_AGENT_ID: agentId }, scratch,
      );
      expect(code).toBe(1);
      expect(stderr).toContain(invalidAgentIdMessage(agentId));
      expect(stdout).not.toContain("Exporting agent");
      expect(paths).toEqual([]);
      expect(listTree(exportsDir)).toEqual([]);
      expect(listTree(keysDir)).toEqual([]);
    }, 25_000);
  }

  test("an invalid id with --include-key is refused before reading its planted key", async () => {
    const agentId = "bad/id";
    const keysDir = join(scratch, "include-key-keys");
    const keyPath = join(keysDir, `${agentId}.key`);
    const keyReadLog = join(scratch, "key-reads.log");
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "planted-key-material");
    writeFileSync(keyReadLog, "");
    const { stderr, code, paths } = await runCli(
      ["export", agentId, "--include-key", "--url", URL, "--admin-pass", "test-pass-3136", "--keys-dir", keysDir],
      { MOCK_AGENT_STATUS: "200", MOCK_AGENT_ID: agentId, MOCK_KEY_READ_PATH: keyPath, MOCK_KEY_READ_LOG: keyReadLog }, scratch,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(invalidAgentIdMessage(agentId));
    expect(readFileSync(keyReadLog, "utf8")).toBe("");
    expect(paths).toEqual([]);
  }, 25_000);
});

describe("flair export: default output stays inside the exports directory (#3136)", () => {
  test("a valid id resolves to a direct child of the exports directory", () => {
    const exportsDir = join(tmpdir(), "flair-export-3136-helper", ".flair", "exports");
    expect(defaultExportOutputPath(exportsDir, "agent-a", 123)).toBe(join(resolve(exportsDir), "agent-a-123.json"));
  });

  test("the builder returns null for a name whose path leaves the exports directory", () => {
    const exportsDir = join(tmpdir(), "flair-export-3136-helper", ".flair", "exports");
    expect(defaultExportOutputPath(exportsDir, "../escape", 123)).toBeNull();
  });
});
