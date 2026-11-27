/**
 * flair#3136 item 1: every command that builds an agent key path from an id
 * applies the shared agent-ID rule before it builds the path. Each case runs
 * the built CLI in a HOME-isolated child whose preload records the readFileSync
 * and openSync path arguments and the path of each global fetch request. A
 * planted sentinel sits at
 * the path an unchecked `<id>.key` join would name; the run must refuse with
 * the shared message, open no key path (inside the keys directory or at the
 * escape path) and send no request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { ensureCliBuild, spawnCli } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { invalidAgentIdMessage } from "../../src/lib/agent-id-rule.js";

const PRELOAD = resolve(import.meta.dirname, "../../test/fixtures/key-path-read-log-preload.cjs");
const CHILD_DEADLINE_MS = 20_000;
const BAD_IDS = ["bad/id", "..", ""];

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  reads: string[];
  requests: string[];
}

function runCli(args: string[], home: string): Promise<CliResult> {
  const readLog = join(home, "reads.log");
  const fetchLog = join(home, "requests.log");
  writeFileSync(readLog, "");
  writeFileSync(fetchLog, "");
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    FLAIR_TEST_KEY_READ_LOG: readLog,
    FLAIR_TEST_FETCH_LOG: fetchLog,
  });
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawnCli(args, {
      cwd: home,
      env,
      timeout: 20_000, // literal for the spawn-budget gate
      preload: PRELOAD,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, {
          status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr,
        })));
        return;
      }
      const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      resolvePromise({ stdout, stderr, code, reads: lines(readLog), requests: lines(fetchLog) });
    });
  });
}

let scratch: string;
beforeAll(() => {
  ensureCliBuild();
  scratch = mkdtempSync(join(tmpdir(), "flair-key-path-3136-"));
}, 120_000);
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface CommandCase {
  name: string;
  args: (id: string) => string[];
}

const CASES: CommandCase[] = [
  { name: "flair reembed --agent", args: (id) => ["reembed", "--agent", id, "--port", "1", "--ops-port", "1"] },
  {
    name: "flair migrate-harness-memory --agent",
    args: (id) => ["migrate-harness-memory", "--target", "claude-code", "--agent", id, "--dry-run"],
  },
  { name: "flair doctor --agent", args: (id) => ["doctor", "--agent", id, "--port", "1"] },
  { name: "flair mcp token --agent-id", args: (id) => ["mcp", "token", "--agent-id", id, "--dry-run"] },
];

describe("flair#3136 — a command refuses an invalid agent id before it builds a key path", () => {
  for (const command of CASES) {
    for (const id of BAD_IDS) {
      test(`${command.name} refuses ${JSON.stringify(id)}, reads no key path and sends no request`, async () => {
        const home = join(scratch, `home-${command.name.replace(/[^a-z]+/gi, "-")}-${encodeURIComponent(id)}`);
        const keysDir = join(home, ".flair", "keys");
        const sentinel = join(keysDir, `${id}.key`);
        mkdirSync(dirname(sentinel), { recursive: true });
        writeFileSync(sentinel, `sentinel-${id}`);

        const { stdout, stderr, code, reads, requests } = await runCli(command.args(id), home);

        const out = stdout + stderr;
        expect(code, out).toBe(1);
        expect(out).toContain(invalidAgentIdMessage(id));
        expect(reads).not.toContain(sentinel);
        expect(reads.filter((path) => path.startsWith(keysDir + sep))).toEqual([]);
        expect(requests).toEqual([]);
        expect(existsSync(sentinel)).toBe(true);
        expect(readFileSync(sentinel, "utf8")).toBe(`sentinel-${id}`);
      }, 30_000);
    }
  }
});
