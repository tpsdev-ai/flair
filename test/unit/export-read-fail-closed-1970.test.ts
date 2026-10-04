/**
 * flair#1970: the built export CLI refuses failed reads before writing a file.
 * A Bun preload replaces fetch inside the child, so the test exercises the
 * command boundary without requiring a loopback socket.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const PRELOAD = join(import.meta.dirname ?? __dirname, "..", "fixtures", "export-fetch-1970.cjs");
const AGENT = "agent one/2";
const URL = "http://example.test";

interface CliResult { stdout: string; stderr: string; code: number | null; paths: string[] }
function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const logPath = join(cwd, "requests.log");
    writeFileSync(logPath, "");
    const startedAt = Date.now();
    const child = spawn("bun", ["--preload", PRELOAD, CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, HOME: cwd, FLAIR_AGENT_ID: "", MOCK_PATH_LOG: logPath, MOCK_AGENT_ID: AGENT, ...env },
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
      resolve({ stdout, stderr, code, paths });
    });
  });
}

describe("flair export: failed reads never create a complete-looking file (#1970)", () => {
  let scratch: string;
  beforeAll(() => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-export-1970-home-"));
  }, 120_000);
  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  test("a 5xx Agent read reports the failure and writes no file", async () => {
    const output = join(scratch, "failed-agent-500.json");
    const { stdout, stderr, code, paths } = await runCli(
      ["export", AGENT, "--url", URL, "--admin-pass", "test-pass-1970", "--output", output],
      { MOCK_AGENT_STATUS: "500" }, scratch,
    );
    expect(code).not.toBe(0);
    expect(stdout + stderr).not.toContain("not found");
    expect(stderr).toContain("could not read agent");
    expect(stderr).toContain("Check instance access and retry");
    expect(paths).toEqual([`/Agent/${encodeURIComponent(AGENT)}`]);
    expect(existsSync(output)).toBe(false);
  }, 25_000);

  test("a 404 Agent read says not found and writes no file", async () => {
    const output = join(scratch, "failed-agent-404.json");
    const { stderr, code, paths } = await runCli(
      ["export", AGENT, "--url", URL, "--admin-pass", "test-pass-1970", "--output", output],
      { MOCK_AGENT_STATUS: "404" }, scratch,
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
    expect(paths).toEqual([`/Agent/${encodeURIComponent(AGENT)}`]);
    expect(existsSync(output)).toBe(false);
  }, 25_000);

  test("a 200 null Agent body reports an unreadable record and writes no file", async () => {
    const output = join(scratch, "empty-agent.json");
    const { stderr, code, paths } = await runCli(
      ["export", AGENT, "--url", URL, "--admin-pass", "test-pass-1970", "--output", output],
      { MOCK_AGENT_STATUS: "200", MOCK_EMPTY_AGENT: "1" }, scratch,
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("could not read agent");
    expect(paths).toEqual([`/Agent/${encodeURIComponent(AGENT)}`]);
    expect(existsSync(output)).toBe(false);
  }, 25_000);

  test("a 200 id-only Agent body reports an incomplete record and writes no file", async () => {
    const output = join(scratch, "id-only-agent.json");
    const { stderr, code, paths } = await runCli(
      ["export", AGENT, "--url", URL, "--admin-pass", "test-pass-1970", "--output", output],
      { MOCK_AGENT_STATUS: "200", MOCK_ID_ONLY_AGENT: "1" }, scratch,
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("could not read agent");
    expect(stderr).toContain("complete requested agent");
    expect(paths).toEqual([`/Agent/${encodeURIComponent(AGENT)}`]);
    expect(existsSync(output)).toBe(false);
  }, 25_000);

  test("successful reads write a complete export", async () => {
    const output = join(scratch, "complete.json");
    const { code, paths } = await runCli(
      ["export", AGENT, "--url", URL, "--admin-pass", "test-pass-1970", "--output", output],
      { MOCK_AGENT_STATUS: "200" }, scratch,
    );
    expect(code).toBe(0);
    expect(paths).toEqual([`/Agent/${encodeURIComponent(AGENT)}`, "/Memory/", "/Soul/", "/MemoryGrant/"]);
    const data = JSON.parse(readFileSync(output, "utf8"));
    expect(data.agent.id).toBe(AGENT);
    expect(data.memories).toEqual([]);
    expect(data.souls).toEqual([]);
    expect(data.grants).toEqual([]);
  }, 25_000);

  for (const [name, path] of [["memories", "/Memory/"], ["souls", "/Soul/"], ["grants", "/MemoryGrant/"]] as const) {
    test(`a failed ${name} read writes no file`, async () => {
      const output = join(scratch, `failed-${name}.json`);
      const { stderr, code, paths } = await runCli(
        ["export", AGENT, "--url", URL, "--admin-pass", "test-pass-1970", "--output", output],
        { MOCK_AGENT_STATUS: "200", MOCK_FAILED_COLLECTION: path }, scratch,
      );
      expect(code).not.toBe(0);
      expect(stderr).toContain(`could not read ${name}`);
      expect(paths).toContain(path);
      expect(existsSync(output)).toBe(false);
    }, 25_000);

    test(`a malformed ${name} item writes no file`, async () => {
      const output = join(scratch, `malformed-${name}.json`);
      const { stderr, code, paths } = await runCli(
        ["export", AGENT, "--url", URL, "--admin-pass", "test-pass-1970", "--output", output],
        { MOCK_AGENT_STATUS: "200", MOCK_MALFORMED_COLLECTION: path }, scratch,
      );
      expect(code).not.toBe(0);
      expect(stderr).toContain(`could not read ${name}`);
      expect(stderr).toContain("malformed item at index 0");
      expect(paths).toContain(path);
      expect(existsSync(output)).toBe(false);
    }, 25_000);
  }
});
