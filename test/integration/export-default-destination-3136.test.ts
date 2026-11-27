/**
 * flair#3136: `flair export` creates its default output exclusively inside
 * <HOME>/.flair/exports — against a REAL Harper and the REAL built CLI.
 * FLAIR_TEST_EXPORT_CLOCK_MS fixes the timestamp so a test knows the name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCliBuild } from "../helpers/build-cli-once";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { tempDir } from "../helpers/temp-dir";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(process.cwd(), "dist", "cli.js");
const CLOCK_MS = 1764200000000;
const AGENT = "agent-a";

let harper: HarperInstance;

interface RunResult { code: number | null; stdout: string; stderr: string }

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) throw new Error("refusing to run: not an instance this test started");
}

/** The built CLI, with a throwaway HOME and no ambient Flair settings. */
function runCli(args: string[], home: string): Promise<RunResult> {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const env = { ...ambient, HOME: home, USERPROFILE: home, NO_COLOR: "1", FLAIR_TEST_EXPORT_CLOCK_MS: String(CLOCK_MS) } as Record<string, string>;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const previousUmask = process.umask(0o022);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(nodeBin({ env }), [CLI_PATH, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000, // literal for the spawn-budget gate
      });
    } finally {
      process.umask(previousUmask);
    }
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
  "export", AGENT, "--url", harper.httpURL, "--admin-pass", harper.admin.password, "--keys-dir", join(home, "keys"), ...extra,
];

const defaultPath = (home: string): string => join(home, ".flair", "exports", `${AGENT}-${CLOCK_MS}.json`);

beforeAll(async () => {
  ensureCliBuild();
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  assertOwnInstance(harper);
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: AGENT, name: AGENT, role: "agent", publicKey: Buffer.from(`public-key-${AGENT}`).toString("base64"), createdAt: "2026-10-01T00:00:00.000Z" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status, await res.text()).toBe(200);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair export: default output is created exclusively (#3136)", () => {
  test("without --output it writes <HOME>/.flair/exports/<id>-<ts>.json", async () => {
    const home = tempDir("flair-3136-home-");
    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    const parsed = JSON.parse(readFileSync(defaultPath(home), "utf8"));
    expect(parsed).toMatchObject({ version: 1, type: "agent-export", agent: { id: AGENT } });
    expect(parsed.source).toBe(harper.httpURL);
    expect(statSync(defaultPath(home)).mode & 0o777).toBe(0o644);
  }, 60_000);

  test("an existing path at the default name is refused for both key modes", async () => {
    for (const extra of [[], ["--include-key"]]) {
      const home = tempDir("flair-3136-home-");
      const exportsDir = join(home, ".flair", "exports");
      mkdirSync(exportsDir, { recursive: true });
      const planted = defaultPath(home);
      const outside = join(home, "outside.json");
      writeFileSync(outside, "sentinel");
      symlinkSync(outside, planted);

      const result = await runCli(exportArgs(home, extra), home);
      expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(planted);
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
      expect(readdirSync(exportsDir)).toEqual([`${AGENT}-${CLOCK_MS}.json`]);
    }
  }, 120_000);

  test("a regular file at the default name is refused without changing its contents", async () => {
    const home = tempDir("flair-3136-home-");
    const planted = defaultPath(home);
    mkdirSync(join(home, ".flair", "exports"), { recursive: true });
    writeFileSync(planted, "sentinel");
    const result = await runCli(exportArgs(home), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(planted);
    expect(readFileSync(planted, "utf8")).toBe("sentinel");
  }, 60_000);

  test("with --include-key a new default file is created at mode 0600", async () => {
    const home = tempDir("flair-3136-home-");
    mkdirSync(join(home, "keys"), { recursive: true });
    writeFileSync(join(home, "keys", `${AGENT}.key`), "fixture-key-material\n");
    const result = await runCli(exportArgs(home, ["--include-key"]), home);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    const parsed = JSON.parse(readFileSync(defaultPath(home), "utf8"));
    expect(parsed.privateKey).toBe("fixture-key-material");
    expect(statSync(defaultPath(home)).mode & 0o777).toBe(0o600);
  }, 60_000);
});
