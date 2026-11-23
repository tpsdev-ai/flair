/**
 * wait-for-harper.test.ts — the E2E lane's /Health wait.
 *
 * The workflow step starts Harper inside a container and then waits for
 * /Health. `scripts/ci/wait-for-harper.mjs` polls against one elapsed-time
 * budget: each poll's probe and first inspect are bounded by the time left,
 * the final inspect is bounded by the per-request cap, and the waiter checks
 * the budget after the first inspect before it probes and after the final
 * inspect before it reports ready. Every poll inspects the container before it
 * believes /Health. Polling stops when an inspect reports the container not
 * running; the diagnostic runs before the process exits.
 *
 * These tests drive the waiter through a real local HTTP server and a stub
 * `docker` first on PATH. No Docker, no Harper, no external network.
 *
 * The credential is sent as a request header, removed from the environment of
 * every child process, and redacted from printed output in its raw, Base64
 * token and full header forms: the tests assert the server sees it, while the
 * stub's environment and the waiter's output do not. The failure diagnostic
 * is bounded by ten seconds for the container logs plus one per-request cap.
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
 * a test can assert the credential reached no child process. Every call also
 * writes a warning to stderr, so a wait that reads stderr as container state
 * fails (a). `inspect-open-stdout` answers and then holds stdout open past the
 * deadline (p); `inspect-ignore-term` ignores SIGTERM and sleeps past its cap
 * (q); `inspect-slow-final` sleeps 1.5 s before the second inspect answers (o);
 * `inspect-final-stall` sleeps past the final inspect's cap (r); `logs-error`
 * makes `docker logs` fail with that file's text (s).
 */
const DOCKER_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$WAIT_STUB_DIR/docker-argv.log"
printf '%s\\n' "\${HARPER_START_CREDENTIALS-<unset>}" >> "$WAIT_STUB_DIR/docker-env.log"
echo "docker stub: warning on stderr" >&2
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
    if [ -f "$WAIT_STUB_DIR/inspect-ignore-term" ]; then
      trap '' TERM
      exec sleep 6
    fi
    if [ -f "$WAIT_STUB_DIR/inspect-open-stdout" ]; then
      printf '%s %s\\n' "$(cat "$WAIT_STUB_DIR/running")" "$(cat "$WAIT_STUB_DIR/exit-code")"
      sleep 2 &
      exit 0
    fi
    if [ -f "$WAIT_STUB_DIR/inspect-sleep" ]; then
      exec node -e 'setTimeout(() => {}, 6000)'
    fi
    if [ -f "$WAIT_STUB_DIR/inspect-sequence" ]; then
      mapfile -t states < "$WAIT_STUB_DIR/inspect-sequence"
      count=$(cat "$WAIT_STUB_DIR/inspect-count" 2>/dev/null || echo 0)
      index=$count
      if [ "$index" -ge "\${#states[@]}" ]; then index=$(( \${#states[@]} - 1 )); fi
      if [ -f "$WAIT_STUB_DIR/inspect-slow-final" ] && [ "$index" -eq 1 ]; then
        sleep 1.5
      fi
      if [ -f "$WAIT_STUB_DIR/inspect-final-stall" ] && [ "$index" -eq 1 ]; then
        exec node -e 'setTimeout(() => {}, 6000)'
      fi
      printf '%s\\n' "\${states[$index]}"
      printf '%s\\n' "$(( count + 1 ))" > "$WAIT_STUB_DIR/inspect-count"
      exit 0
    fi
    printf '%s %s\\n' "$(cat "$WAIT_STUB_DIR/running")" "$(cat "$WAIT_STUB_DIR/exit-code")"
    ;;
  logs)
    if [ -f "$WAIT_STUB_DIR/logs-error" ]; then
      cat "$WAIT_STUB_DIR/logs-error" >&2
      exit 71
    fi
    echo "stub container log for \${1:-}"
    if [ -f "$WAIT_STUB_DIR/container-log" ]; then
      cat "$WAIT_STUB_DIR/container-log"
    fi
    printf 'env HARPER_START_CREDENTIALS=%s\\n' "\${HARPER_START_CREDENTIALS-<unset>}"
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

function sandbox(
  options: {
    running?: string;
    exitCode?: string;
    inspectFails?: boolean;
    inspectSequence?: string[];
    inspectSlowFinal?: boolean;
    inspectSleep?: boolean;
    inspectOpenStdout?: boolean;
    inspectIgnoreTerm?: boolean;
    inspectFinalStall?: boolean;
    logsFailError?: string;
    containerLog?: string;
  } = {},
): Sandbox {
  const root = tempDir("flair-wait-harper-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), DOCKER_STUB);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(root, "running"), `${options.running ?? "true"}\n`);
  writeFileSync(join(root, "exit-code"), `${options.exitCode ?? "0"}\n`);
  if (options.inspectFails) writeFileSync(join(root, "inspect-fails"), "");
  if (options.inspectSequence) writeFileSync(join(root, "inspect-sequence"), `${options.inspectSequence.join("\n")}\n`);
  if (options.inspectSlowFinal) writeFileSync(join(root, "inspect-slow-final"), "");
  if (options.inspectSleep) writeFileSync(join(root, "inspect-sleep"), "");
  if (options.inspectOpenStdout) writeFileSync(join(root, "inspect-open-stdout"), "");
  if (options.inspectIgnoreTerm) writeFileSync(join(root, "inspect-ignore-term"), "");
  if (options.inspectFinalStall) writeFileSync(join(root, "inspect-final-stall"), "");
  if (options.logsFailError) writeFileSync(join(root, "logs-error"), options.logsFailError);
  if (options.containerLog) writeFileSync(join(root, "container-log"), options.containerLog);
  return { root, bin };
}

interface Run {
  status: number | null;
  output: string;
  seconds: number;
}

async function run(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = CASE_TIMEOUT_MS,
): Promise<Run> {
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
  const kill = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
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
    "(b) a dead container ends the wait even while /Health answers 200",
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
    "(c) when /Health never answers, polling stops at the budget; the timeout line and logs follow",
    async () => {
      // Polling stops at the 2s budget; the failure diagnostic then takes at
      // most ten seconds of container logs plus one per-request cap.
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
    "(h) the credential is a request header, absent from child environments and printed output",
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
      const token = Buffer.from(SENTINEL).toString("base64");
      expect(server.authorizations).toContain(`Basic ${token}`);
      expect(result.output).not.toContain("test-pass");
      expect(result.output).not.toContain(token);
      const argv = readFileSync(join(box.root, "docker-argv.log"), "utf8");
      expect(argv).toContain("inspect");
      expect(argv).not.toContain("test-pass");
      expect(readFileSync(join(box.root, "docker-env.log"), "utf8")).not.toContain("test-pass");

      // Failure path: the diagnostic request is unauthenticated; the docker
      // children do not inherit the credential, and its raw value and Base64
      // token are redacted from the container logs and the response headers.
      const failing = sandbox({
        running: "false",
        exitCode: "9",
        containerLog: `raw ${SENTINEL}\ntoken ${token}\n`,
      });
      const diagnostic = await health((_index, res) => {
        res.statusCode = 503;
        res.setHeader("www-authenticate", `Basic ${token}`);
        res.setHeader("x-echo-raw", SENTINEL);
        res.end("no");
      });
      const failed = await run(
        failing,
        [
          "--container",
          "harper-flair",
          ...WAIT_ARGS(diagnostic.url),
          "--credentials-env",
          "HARPER_START_CREDENTIALS",
          "--budget-seconds",
          "20",
        ],
        { HARPER_START_CREDENTIALS: SENTINEL },
      );
      expect(failed.status).toBe(1);
      expect(failed.output).toContain("Unauthenticated diagnostic request:");
      expect(failed.output).toContain("[redacted]");
      expect(failed.output).not.toContain("test-pass");
      expect(failed.output).not.toContain(token);
      expect(diagnostic.authorizations).toHaveLength(0);
      expect(readFileSync(join(failing.root, "docker-argv.log"), "utf8")).not.toContain("test-pass");
      expect(readFileSync(join(failing.root, "docker-env.log"), "utf8")).not.toContain("test-pass");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(j) a response that sends headers and never ends its body still ends the wait",
    async () => {
      const server = await health((_index, res) => {
        res.on("error", () => {});
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial body");
      });
      const box = sandbox();
      const result = await run(
        box,
        [
          "--container",
          "harper-flair",
          ...WAIT_ARGS(server.url),
          "--budget-seconds",
          "2",
          "--per-request-ms",
          "500",
        ],
        {},
        5000,
      );

      expect(result.status).toBe(0);
      expect(result.output).toContain("Harper ready");
      expect(result.seconds).toBeLessThan(4);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(k) an exit between the probe and the second inspect fails, naming the exit",
    async () => {
      const server = await health(STATUS(200));
      const box = sandbox({ inspectSequence: ["true 0", "false 3"] });
      const result = await run(box, [
        "--container",
        "harper-flair",
        ...WAIT_ARGS(server.url),
        "--budget-seconds",
        "20",
      ]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("exit code 3");
      expect(result.output).not.toContain("Harper ready");
      // One probe plus the unauthenticated diagnostic request.
      expect(server.requests()).toBe(2);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(l) an inspect that outlasts its bound is cut off within the budget and a margin",
    async () => {
      const server = await health(STATUS(503));
      const box = sandbox({ inspectSleep: true });
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
      expect(result.output).toContain("cannot inspect container 'harper-flair'");
      expect(result.seconds).toBeLessThan(4);
      expect(server.requests()).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(m) HARPER_START_BUDGET_S alone bounds the wait",
    async () => {
      const server = await health(STATUS(503));
      const box = sandbox();
      const result = await run(
        box,
        ["--container", "harper-flair", "--url", server.url, "--poll-interval-ms", "100", "--per-request-ms", "200"],
        { HARPER_START_BUDGET_S: "2" },
        6000,
      );

      expect(result.status).toBe(1);
      expect(result.output).toContain("Harper did not answer /Health within 2s");
      expect(result.seconds).toBeGreaterThanOrEqual(1.8);
      expect(result.seconds).toBeLessThan(6);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(n) the budget rejects values that overflow a safe whole number",
    () => {
      expect(() => resolveBudget("9".repeat(400), undefined)).toThrow();
      expect(() => resolveBudget(undefined, "9".repeat(400))).toThrow();
      expect(() => resolveBudget("86401", undefined)).toThrow();
      expect(resolveBudget("86400", undefined)).toBe(86400);
    },
  );

  test(
    "(o) a final inspect that answers running after the deadline fails as a timeout",
    async () => {
      const server = await health(STATUS(200));
      const box = sandbox({ inspectSequence: ["true 0", "true 0"], inspectSlowFinal: true });
      const result = await run(box, [
        "--container",
        "harper-flair",
        "--url",
        server.url,
        "--poll-interval-ms",
        "100",
        "--per-request-ms",
        "2000",
        "--budget-seconds",
        "1",
      ]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("Harper did not answer /Health within 1s");
      expect(result.output).not.toContain("Harper ready");
      expect(result.seconds).toBeGreaterThanOrEqual(1.4);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(p) a first inspect that answers after the deadline times out without probing",
    async () => {
      const server = await health((_index, res) => {
        setTimeout(() => {
          res.statusCode = 200;
          res.end("ok");
        }, 100);
      });
      const box = sandbox({ inspectOpenStdout: true });
      const result = await run(
        box,
        [
          "--container",
          "harper-flair",
          "--url",
          server.url,
          "--poll-interval-ms",
          "100",
          "--per-request-ms",
          "5000",
          "--progress-interval-ms",
          "1",
          "--budget-seconds",
          "1",
          "--credentials-env",
          "HARPER_START_CREDENTIALS",
        ],
        { HARPER_START_CREDENTIALS: SENTINEL },
      );

      expect(result.status).toBe(1);
      expect(result.output).toContain("Harper did not answer /Health within 1s");
      // Without the budget check after the first inspect, a probe runs, fails
      // and prints the progress line before the timeout.
      expect(result.output).not.toContain("waiting for Harper /Health");
      // Only the unauthenticated diagnostic request answers; the probe sends
      // the credential and never reaches the server.
      expect(server.requests()).toBe(1);
      expect(server.authorizations).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(q) a docker inspect that ignores SIGTERM is killed at its bound",
    async () => {
      const server = await health(STATUS(200));
      const box = sandbox({ inspectIgnoreTerm: true });
      const result = await run(box, [
        "--container",
        "harper-flair",
        ...WAIT_ARGS(server.url),
        "--budget-seconds",
        "10",
        "--per-request-ms",
        "500",
      ]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("cannot inspect container 'harper-flair'");
      expect(result.seconds).toBeLessThan(3);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(r) a final inspect that outlasts its per-request cap is cut off",
    async () => {
      const server = await health(STATUS(200));
      const box = sandbox({ inspectSequence: ["true 0", "true 0"], inspectFinalStall: true });
      const result = await run(box, [
        "--container",
        "harper-flair",
        ...WAIT_ARGS(server.url),
        "--budget-seconds",
        "10",
        "--per-request-ms",
        "500",
      ]);

      expect(result.status).toBe(1);
      expect(result.output).toContain("cannot inspect container 'harper-flair'");
      expect(result.output).not.toContain("Harper ready");
      expect(result.seconds).toBeLessThan(2);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(s) the docker logs error branch redacts the credential",
    async () => {
      const server = await health(STATUS(200));
      const token = Buffer.from(SENTINEL).toString("base64");
      const box = sandbox({
        running: "false",
        exitCode: "5",
        logsFailError: `docker logs error: raw ${SENTINEL} token ${token}\n`,
      });
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

      expect(result.status).toBe(1);
      expect(result.output).toContain("docker logs failed:");
      expect(result.output).toContain("[redacted]");
      expect(result.output).not.toContain("test-pass");
      expect(result.output).not.toContain(token);
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
