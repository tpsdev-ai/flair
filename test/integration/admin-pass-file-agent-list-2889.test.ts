/**
 * admin-pass-file-agent-list-2889.test.ts — flair#2889
 *
 * The documented `--admin-pass-file` path must work on the commands that take
 * `--admin-pass`. This drives the REAL built CLI against a throwaway Harper:
 * `flair agent list --admin-pass-file` lists agents from a 0600 file, refuses a
 * 0644 file with the same message `agent add` gives, and refuses a missing file
 * by naming it instead of falling through to "no password".
 *
 * Both the Harper install dir and the CLI HOME are fresh temp trees; the CLI is
 * pointed at the instance's numeric HTTP/ops ports explicitly.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnCli } from "../helpers/build-cli-once.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startHarper,
  stopHarper,
  type HarperInstance,
  HARPER_STOP_BUDGET_MS,
  HARPER_START_BUDGET_MS,
} from "../helpers/harper-lifecycle";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 30_000;
const AGENT_ID = "agent-a";
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass

let harper: HarperInstance;
let cliHome: string;
let passFile0600: string;
let passFile0644: string;
let missingPassFile: string;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawnCli(args, {
      env: {
        ...process.env,
        HOME: cliHome,
        FLAIR_URL: harper.httpURL,
        FLAIR_OPS_PORT: new URL(harper.opsURL).port,
        // Defensive: no ambient credential may stand in for the flag under test.
        FLAIR_TOKEN: "",
        FLAIR_ADMIN_PASS: "",
        HDB_ADMIN_PASSWORD: "",
        ...extraEnv,
      },
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(
            childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, {
              status: code,
              signal,
              elapsedMs: Date.now() - startedAt,
              stdout,
              stderr,
            }),
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  harper = await startHarper();
  // Every request this suite makes goes to the instance just started: the
  // helper binds loopback on OS-assigned ports, and both URLs are passed to the
  // CLI as numeric ports below.
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  expect(http.hostname).toBe("127.0.0.1");
  expect(ops.hostname).toBe("127.0.0.1");
  expect(Number(http.port)).toBeGreaterThan(0);
  expect(Number(ops.port)).toBeGreaterThan(0);

  cliHome = mkdtempSync(join(tmpdir(), "flair-2889-home-"));
  passFile0600 = join(cliHome, "admin-pass-0600");
  passFile0644 = join(cliHome, "admin-pass-0644");
  missingPassFile = join(cliHome, "admin-pass-missing");
  writeFileSync(passFile0600, `${ADMIN_PASS}\n`, "utf-8");
  chmodSync(passFile0600, 0o600);
  writeFileSync(passFile0644, `${ADMIN_PASS}\n`, "utf-8");
  chmodSync(passFile0644, 0o644);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) rmSync(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2889 — agent list reads --admin-pass-file", () => {
  test("a 0600 file lists agents on the ephemeral instance", async () => {
    const httpPort = new URL(harper.httpURL).port;
    const opsPort = new URL(harper.opsURL).port;

    const add = await runCli([
      "agent", "add", AGENT_ID,
      "--admin-pass", ADMIN_PASS,
      "--port", httpPort,
      "--ops-port", opsPort,
    ]);
    if (add.code !== 0) console.error(`agent add failed:\n${add.stdout}\n${add.stderr}`);
    expect(add.code).toBe(0);

    const list = await runCli([
      "agent", "list",
      "--admin-pass-file", passFile0600,
      "--port", httpPort,
    ]);
    if (list.code !== 0) console.error(`agent list failed:\n${list.stdout}\n${list.stderr}`);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(AGENT_ID);
  }, CASE_BUDGET_MS);

  test("a 0644 file is refused with the message agent add gives", async () => {
    const httpPort = new URL(harper.httpURL).port;
    const opsPort = new URL(harper.opsURL).port;

    const list = await runCli([
      "agent", "list",
      "--admin-pass-file", passFile0644,
      "--port", httpPort,
    ]);
    const add = await runCli([
      "agent", "add", "agent-b",
      "--admin-pass-file", passFile0644,
      "--port", httpPort,
      "--ops-port", opsPort,
    ]);

    expect(list.code).toBe(1);
    expect(add.code).toBe(1);
    expect(list.stderr).toContain("permissions 644 are too open");
    expect(list.stderr).toContain("chmod 600");
    expect(list.stderr.trim()).toBe(add.stderr.trim());
    expect(list.stdout).not.toContain(AGENT_ID);
  }, CASE_BUDGET_MS);

  test("a missing file is refused by name, never treated as no password", async () => {
    const httpPort = new URL(harper.httpURL).port;

    const list = await runCli(
      [
        "agent", "list",
        "--admin-pass-file", missingPassFile,
        "--port", httpPort,
      ],
      // An ambient password is present. If the missing file were mistaken for
      // "no password", this would succeed and print the agent list.
      { FLAIR_ADMIN_PASS: ADMIN_PASS },
    );

    expect(list.code).toBe(1);
    expect(list.stderr).toContain(`--admin-pass-file path does not exist: ${missingPassFile}`);
    expect(list.stdout).toBe("");
  }, CASE_BUDGET_MS);
});
