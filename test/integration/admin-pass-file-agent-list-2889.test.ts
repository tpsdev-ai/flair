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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key) && key !== "ROOTPATH")),
      HOME: cliHome,
      ...extraEnv,
    };
    for (const key of ["FLAIR_TARGET", "FLAIR_OPS_TARGET", "FLAIR_URL", "FLAIR_OPS_PORT", "FLAIR_HTTP_BIND", "FLAIR_OPS_BIND", "FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL", "ROOTPATH"]) {
      expect(env).not.toHaveProperty(key);
    }
    for (const key of ["FLAIR_AGENT_ID", "FLAIR_KEY_DIR", "FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "FLAIR_ADMIN_USER", "HDB_ADMIN_PASSWORD"]) {
      if (!(key in extraEnv)) expect(env).not.toHaveProperty(key);
    }
    const child = spawnCli([...args, "--admin-user", harper.admin.username], {
      env,
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
  if (process.env.HARPER_HTTP_URL) throw new Error("admin-pass-file-agent-list-2889 requires an isolated Harper instance; unset HARPER_HTTP_URL");
  harper = await startHarper();
  expect(harper.external).toBe(false);
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  expect(http.hostname).toBe("127.0.0.1");
  expect(ops.hostname).toBe("127.0.0.1");
  expect(Number(http.port)).toBeGreaterThan(0);
  expect(Number(ops.port)).toBeGreaterThan(0);

  cliHome = mkdtempSync(join(tmpdir(), "flair-2889-home-"));
  mkdirSync(join(cliHome, ".flair"));
  writeFileSync(join(cliHome, ".flair", "config.yaml"), `port: ${http.port}\nopsPort: ${ops.port}\n`);
  passFile0600 = join(cliHome, "admin-pass-0600");
  passFile0644 = join(cliHome, "admin-pass-0644");
  missingPassFile = join(cliHome, "admin-pass-missing");
  writeFileSync(passFile0600, `${harper.admin.password}\n`, "utf-8");
  chmodSync(passFile0600, 0o600);
  writeFileSync(passFile0644, `${harper.admin.password}\n`, "utf-8");
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
      "--admin-pass", harper.admin.password,
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
      { FLAIR_ADMIN_PASS: harper.admin.password },
    );

    expect(list.code).toBe(1);
    expect(list.stderr).toContain(`--admin-pass-file path does not exist: ${missingPassFile}`);
    expect(list.stdout).toBe("");
  }, CASE_BUDGET_MS);
});

describe("flair#2889 — agent list does not print the credential an endpoint echoes", () => {
  test("a non-ok body is redacted with the values the request sent", async () => {
    let seenAuth = "";
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        seenAuth = req.headers.get("authorization") ?? "";
        return new Response(`endpoint echoed Authorization: ${seenAuth}`, { status: 500 });
      },
    });
    const redactionHome = mkdtempSync(join(tmpdir(), "flair-2889-redact-"));
    try {
      mkdirSync(join(redactionHome, ".flair"));
      writeFileSync(
        join(redactionHome, ".flair", "config.yaml"),
        `port: ${Number(stub.port) + 1}\nopsPort: ${Number(stub.port)}\n`,
      );
      const list = await runCli(
        ["agent", "list", "--admin-pass-file", passFile0600],
        { HOME: redactionHome },
      );
      expect(list.code).toBe(1);
      expect(seenAuth).toContain("Basic ");
      expect(list.stderr).toContain("[redacted]");
      expect(list.stderr).not.toContain(harper.admin.password);
      expect(list.stderr).not.toContain("passed inline");
    } finally {
      stub.stop(true);
      rmSync(redactionHome, { recursive: true, force: true });
    }
  }, CASE_BUDGET_MS);
});

describe("flair#2889 — the inline warning keys on --admin-pass, not the file", () => {
  test("an inline --admin-pass still warns and a file form does not", async () => {
    const secret = "inline-admin-pass-fixture-2889";
    const home = mkdtempSync(join(tmpdir(), "flair-2889-inline-"));
    const file = join(home, "admin-pass");
    writeFileSync(file, secret + "\n", "utf-8");
    chmodSync(file, 0o600);
    const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 500 }) });
    try {
      mkdirSync(join(home, ".flair"));
      writeFileSync(join(home, ".flair", "config.yaml"), `port: ${Number(stub.port) + 1}\nopsPort: ${Number(stub.port)}\n`);
      const inline = await runCli(["agent", "list", "--admin-pass", secret], { HOME: home });
      expect(inline.stderr).toContain("--admin-pass passed inline");
      const fromFile = await runCli(["agent", "list", "--admin-pass-file", file], { HOME: home });
      expect(fromFile.stderr).not.toContain("--admin-pass passed inline");
    } finally {
      stub.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }, CASE_BUDGET_MS);
});
