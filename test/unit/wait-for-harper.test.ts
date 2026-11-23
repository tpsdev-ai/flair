/**
 * wait-for-harper.test.ts — the E2E lane's /Health wait.
 *
 * The workflow step starts Harper inside a container and then waits for
 * /Health. `scripts/ci/wait-for-harper.mjs` works against one elapsed-time
 * budget: every request and inspect is bounded by the time left, each poll
 * inspects the container before it believes /Health, and a dead container
 * fails at once with its exit code and logs.
 *
 * These tests drive the waiter through a real local HTTP server and a stub
 * `docker` first on PATH. No Docker, no Harper, no external network.
 *
 * The credential is sent only as a request header: the tests assert the
 * server sees it, and that it never appears in the stub's argv or in the
 * waiter's output, including on the failure path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

import { resolveBudget } from "../../scripts/ci/wait-for-harper.mjs";
import { tempDir } from "../helpers/temp-dir.ts";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "ci", "wait-for-harper.mjs");
const CASE_TIMEOUT_MS = 20_000;
const SENTINEL = "admin:test-pass";

/**
 * Stub `docker`: `inspect --format <format> <name>` answers from files in the
 * sandbox, `logs <name>` prints one known line. Each call records its argv so
 * a test can assert the credential reached no child process.
 */
const DOCKER_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$WAIT_STUB_DIR/docker-argv.log"
cmd=\${1:?}; shift
case "$cmd" in
  inspect)
    if [ -f "$WAIT_STUB_DIR/inspect-fails" ]; then
      echo "docker stub: cannot inspect" >&2
      exit 70
    fi
    [ "\${1:-}" = "--format" ] || { echo "docker stub: expected --format" >&2; exit 64; }
    fmt=\${2:-}
    case "$fmt" in
      *State.Running*State.ExitCode*) : ;;
      *) echo "docker stub: unexpected format '$fmt'" >&2; exit 64 ;;
    esac
    printf '%s %s\\n' "$(cat "$WAIT_STUB_DIR/running")" "$(cat "$WAIT_STUB_DIR/exit-code")"
    ;;
  logs)
    echo "stub container log for \${1:-}"
    ;;
  *)
    echo "docker stub: unexpected command '$cmd'" >&2
    exit 64
    ;;
esac
`;

interface Sandbox {
  root: string;
  bin: string;
}

function sandbox(options: { running?: string; exitCode?: string; inspectFails?: boolean } = {}): Sandbox {
  const root = tempDir("flair-wait-harper-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), DOCKER_STUB);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(root, "running"), `${options.running ?? "true"}\n`);
  writeFileSync(join(root, "exit-code"), `${options.exitCode ?? "0"}\n`);
  if (options.inspectFails) writeFileSync(join(root, "inspect-fails"), "");
  return { root, bin };
}

interface Run {
  status: number | null;
  output: string;
  seconds: number;
}

async function run(box: Sandbox, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const started = Date.now();
  const child = spawn("node", [SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      WAIT_STUB_DIR: box.root,
      HARPER_START_BUDGET_S: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const kill = setTimeout(() => child.kill("SIGKILL"), CASE_TIMEOUT_MS);
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(kill);
  return { status, output: `${stdout}${stderr}`, seconds: (Date.now() - started) / 1000 };
}

interface HealthServer {
  url: string;
  requests: () => number;
  authorizations: string[];
  close: () => Promise<void>;
}

async function startHealth(respond: (index: number, res: ServerResponse) => void): Promise<HealthServer> {
  let count = 0;
  const authorizations: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    count += 1;
    if (req.headers.authorization) authorizations.push(req.headers.authorization);
    respond(count, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/Health`,
    requests: () => count,
    authorizations,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const servers: HealthServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function health(respond: (index: number, res: ServerResponse) => void): Promise<HealthServer> {
  const server = await startHealth(respond);
  servers.push(server);
  return server;
}

const STATUS = (code: number) => (_index: number, res: ServerResponse) => {
  res.statusCode = code;
  res.end(code === 200 ? "ok" : "not yet");
};

const WAIT_ARGS = (url: string) => [
  "--url",
  url,
  "--poll-interval-ms",
  "100",
  "--per-request-ms",
  "1000",
];

describe("wait-for-harper.mjs", () => {
  test(
    "(a) succeeds once /Health answers after a few polls",
    async () => {
      const server = await health((index, res) => {
        res.statusCode = index >= 3 ? 200 : 503;
        res.end();
      });
      const box = sandbox();
      const result = await run(
        box,
        ["--container", "harper-flair", ...WAIT_ARGS(server.url), "--budget-seconds", "20"],
        { HARPER_START_CREDENTIALS: SENTINEL },
      );

      expect(result.status).toBe(0);
      expect(result.output).toMatch(/Harper ready after \d+s/);
      expect(server.requests()).toBeGreaterThanOrEqual(3);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(b) a dead container fails at once even while /Health answers 200",
    async () => {
      const server = await health(STATUS(200));
      const box = sandbox({ running: "false", exitCode: "7" });
      const result = await run(box, ["--container", "harper-flair", ...WAIT_ARGS(server.url), "--budget-seconds", "30"]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("exit code 7");
      expect(result.output).toContain("stub container log for harper-flair");
      expect(result.seconds).toBeLessThan(10);
      expect(result.output).not.toContain("Harper ready");
      expect(result.output).not.toContain("did not answer /Health within");
      // The first inspect happened before the probe, so /Health was never
      // believed: only the unauthenticated diagnostic request reached it.
      expect(server.requests()).toBe(1);
      expect(server.authorizations).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(c) fails at the budget, with the timeout line and logs, when /Health never answers",
    async () => {
      const server = await health(STATUS(503));
      const box = sandbox();
      const result = await run(box, [
        "--container",
        "harper-flair",
        ...WAIT_ARGS(server.url),
        "--budget-seconds",
        "2",
        "--per-request-ms",
        "500",
      ]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("Harper did not answer /Health within 2s");
      expect(result.output).toContain("stub container log for harper-flair");
      expect(result.seconds).toBeGreaterThanOrEqual(1.9);
      expect(result.seconds).toBeLessThan(5);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(d) a stalled /Health is cut off at the budget",
    async () => {
      const server = await health(() => {
        // Never answer: the request stays open until the waiter aborts it.
      });
      const box = sandbox();
      const result = await run(box, [
        "--container",
        "harper-flair",
        ...WAIT_ARGS(server.url),
        "--budget-seconds",
        "1",
        "--per-request-ms",
        "500",
      ]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("Harper did not answer /Health within 1s");
      expect(result.seconds).toBeGreaterThanOrEqual(0.9);
      expect(result.seconds).toBeLessThan(4);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(e) prints a progress line on the elapsed-time interval",
    async () => {
      const server = await health(STATUS(503));
      const box = sandbox();
      const result = await run(box, [
        "--container",
        "harper-flair",
        ...WAIT_ARGS(server.url),
        "--budget-seconds",
        "1",
        "--per-request-ms",
        "200",
        "--progress-interval-ms",
        "200",
      ]);

      expect(result.status).toBe(1);
      expect(result.output).toMatch(/waiting for Harper \/Health: \d+s/);
    },
    CASE_TIMEOUT_MS,
  );

  test("(f) the budget is the flag, else the environment, else 300", async () => {
    expect(resolveBudget("7", "50")).toBe(7);
    expect(resolveBudget(undefined, "7")).toBe(7);
    expect(resolveBudget(undefined, undefined)).toBe(300);
    expect(resolveBudget(undefined, "")).toBe(300);
    expect(() => resolveBudget("0", undefined)).toThrow();

    // The flag wins over the environment, and the timeout line names it.
    const server = await health(STATUS(503));
    const box = sandbox();
    const result = await run(
      box,
      ["--container", "harper-flair", ...WAIT_ARGS(server.url), "--budget-seconds", "1", "--per-request-ms", "200"],
      { HARPER_START_BUDGET_S: "50" },
    );
    expect(result.output).toContain("Harper did not answer /Health within 1s");
    expect(result.seconds).toBeLessThan(5);
  }, CASE_TIMEOUT_MS);

  test(
    "(g) refuses, naming the inspect error, when the container cannot be inspected",
    async () => {
      const server = await health(STATUS(200));
      const box = sandbox({ inspectFails: true });
      const result = await run(box, ["--container", "harper-flair", ...WAIT_ARGS(server.url), "--budget-seconds", "20"]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("cannot inspect container 'harper-flair'");
      expect(result.output).toContain("docker stub: cannot inspect");
      expect(result.output).not.toContain("Harper ready");
      expect(server.requests()).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(h) the credential is only a request header: never on argv, never printed",
    async () => {
      const server = await health(STATUS(200));
      const box = sandbox();
      const result = await run(
        box,
        [
          "--container",
          "harper-flair",
          ...WAIT_ARGS(server.url),
          "--credentials-env",
          "HARPER_START_CREDENTIALS",
          "--budget-seconds",
          "20",
        ],
        { HARPER_START_CREDENTIALS: SENTINEL },
      );

      expect(result.status).toBe(0);
      expect(server.authorizations).toContain(`Basic ${Buffer.from(SENTINEL).toString("base64")}`);
      expect(result.output).not.toContain("test-pass");
      const argv = readFileSync(join(box.root, "docker-argv.log"), "utf8");
      expect(argv).toContain("inspect");
      expect(argv).not.toContain("test-pass");

      // Failure path: the diagnostic request is unauthenticated and the
      // credential is still absent from output and from every child argv.
      const failing = sandbox({ running: "false", exitCode: "9" });
      const failed = await run(
        failing,
        ["--container", "harper-flair", ...WAIT_ARGS(server.url), "--budget-seconds", "20"],
        { HARPER_START_CREDENTIALS: SENTINEL },
      );
      expect(failed.status).toBe(1);
      expect(failed.output).toContain("Unauthenticated diagnostic request:");
      expect(failed.output).not.toContain("test-pass");
      expect(server.authorizations).toHaveLength(1);
      expect(readFileSync(join(failing.root, "docker-argv.log"), "utf8")).not.toContain("test-pass");
    },
    CASE_TIMEOUT_MS,
  );

  test("(i) both workflows call the waiter", () => {
    interface Step {
      name?: string;
      run?: string;
      env?: Record<string, string>;
    }
    interface Workflow {
      jobs: Record<string, { steps?: Step[] }>;
    }
    const read = (path: string) => loadYaml(readFileSync(join(REPO, ".github", "workflows", path), "utf8")) as Workflow;

    const integration = read("test.yml").jobs["test-integration"]?.steps?.find((step) => step.name?.startsWith("Start Harper"));
    expect(integration?.run).toContain("scripts/ci/wait-for-harper.mjs");
    expect(integration?.run).toContain("--credentials-env HARPER_START_CREDENTIALS");
    expect(integration?.env?.HARPER_START_CREDENTIALS).toBe("admin:admin123");

    const smoke = read("smoke.yml").jobs["smoke"]?.steps?.find((step) => step.name?.startsWith("Start Flair"));
    expect(smoke?.run).toContain("scripts/ci/wait-for-harper.mjs");
    expect(smoke?.run).toContain("--container harper-flair-smoke");
    expect(smoke?.env?.HARPER_START_BUDGET_S).toBe("300");
  });
});
