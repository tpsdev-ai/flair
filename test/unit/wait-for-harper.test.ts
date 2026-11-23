/**
 * wait-for-harper.test.ts — the E2E lane's /Health wait.
 *
 * The workflow step starts Harper inside a container (`harper install &&
 * harper dev /flair`) and then waits for /Health. A fixed poll count (60 x 2 s)
 * timed out on loaded runners while the install was still running, and the loop
 * kept sleeping after the container had already exited, so a slow install and a
 * dead container surfaced as the same generic start failure.
 *
 * `scripts/ci/wait-for-harper.sh` waits against an elapsed-time budget and
 * inspects the container on every poll. These tests drive it hermetically: a
 * stub `docker` and `curl` first on PATH, no Docker, no Harper, no port.
 *
 * The cases cover the behaviour the step now relies on:
 *   (a) /Health answers after a few polls — exit 0 and the "ready after" line;
 *   (b) the container exits — the script fails at once, names the exit code,
 *       and prints the container logs, without waiting out the budget;
 *   (c) /Health never answers — the script fails at the budget with the
 *       timeout line, the logs and the verbose curl.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "../helpers/temp-dir.ts";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "ci", "wait-for-harper.sh");
const CASE_TIMEOUT_MS = 30_000;

/**
 * Stub `docker`: `inspect -f <format> <name>` answers from files in the sandbox,
 * `logs <name>` prints one known line. Anything else is a hard error so a
 * change in how the script calls Docker fails loudly instead of silently.
 */
const DOCKER_STUB = `#!/usr/bin/env bash
set -euo pipefail
cmd=\${1:?}; shift
case "$cmd" in
  inspect)
    [ "\${1:-}" = "-f" ] || { echo "docker stub: expected -f" >&2; exit 64; }
    fmt=\${2:?}; name=\${3:?}
    case "$fmt" in
      *State.Running*) cat "$WAIT_STUB_DIR/running" ;;
      *State.ExitCode*) cat "$WAIT_STUB_DIR/exit-code" ;;
      *) echo "docker stub: unexpected format '$fmt'" >&2; exit 64 ;;
    esac
    ;;
  logs)
    name=\${1:?}
    echo "stub container log for $name"
    ;;
  *)
    echo "docker stub: unexpected command '$cmd'" >&2
    exit 64
    ;;
esac
`;

/**
 * Stub `curl`: records its argv in calls.log, then answers from
 * `$WAIT_STUB_DIR/curl-mode`:
 *   healthy         — exit 0
 *   unhealthy       — exit 1
 *   healthy-after:N — exit 1 for the first N calls, then exit 0
 */
const CURL_STUB = `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> "$WAIT_STUB_DIR/calls.log"
mode=$(cat "$WAIT_STUB_DIR/curl-mode")
case "$mode" in
  healthy) exit 0 ;;
  unhealthy) exit 1 ;;
  healthy-after:*)
    want=\${mode#healthy-after:}
    count=0
    [ -f "$WAIT_STUB_DIR/curl-count" ] && count=$(cat "$WAIT_STUB_DIR/curl-count")
    count=$((count + 1))
    printf '%s' "$count" > "$WAIT_STUB_DIR/curl-count"
    [ "$count" -ge "$want" ] && exit 0
    exit 1
    ;;
  *)
    echo "curl stub: bad mode '$mode'" >&2
    exit 64
    ;;
esac
`;

interface Sandbox {
  root: string;
  bin: string;
}

function sandbox(options: { running?: string; exitCode?: string; curlMode: string }): Sandbox {
  const root = tempDir("flair-wait-harper-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), DOCKER_STUB);
  writeFileSync(join(bin, "curl"), CURL_STUB);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(root, "running"), `${options.running ?? "true"}\n`);
  writeFileSync(join(root, "exit-code"), `${options.exitCode ?? "0"}\n`);
  writeFileSync(join(root, "curl-mode"), options.curlMode);
  return { root, bin };
}

interface Run {
  status: number | null;
  output: string;
  seconds: number;
}

function run(box: Sandbox, args: string[], env: Record<string, string> = {}): Run {
  const started = Date.now();
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: CASE_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: `${box.bin}:/usr/bin:/bin`,
      WAIT_STUB_DIR: box.root,
      HARPER_START_BUDGET_S: "",
      ...env,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    seconds: (Date.now() - started) / 1000,
  };
}

describe("wait-for-harper.sh", () => {
  test("(a) succeeds once /Health answers after a few polls", () => {
    const box = sandbox({ curlMode: "healthy-after:3" });
    const result = run(
      box,
      ["harper-flair", "http://localhost:9926/Health", "HARPER_START_CREDENTIALS", "60"],
      { HARPER_START_CREDENTIALS: "admin:test-pass" },
    );

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Harper ready after \d+s/);
    const calls = readFileSync(join(box.root, "calls.log"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(3);
    // The credential reached curl through the named variable, not this script's argv.
    expect(calls[0]).toContain("-u admin:test-pass");
  }, CASE_TIMEOUT_MS);

  test("(b) fails at once, with the exit code, when the container has exited", () => {
    const box = sandbox({ running: "false", exitCode: "7", curlMode: "unhealthy" });
    const result = run(box, ["harper-flair", "http://localhost:9926/Health", "", "60"]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("exit code 7");
    expect(result.output).toContain("stub container log for harper-flair");
    // The failure is the exit check, not the 60 s budget.
    expect(result.seconds).toBeLessThan(10);
    expect(result.output).not.toContain("did not answer /Health within");
  }, CASE_TIMEOUT_MS);

  test("(c) fails at the budget, with logs and a verbose curl, when /Health never answers", () => {
    const box = sandbox({ running: "true", curlMode: "unhealthy" });
    const result = run(box, ["harper-flair", "http://localhost:9926/Health", "", "3"]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("Harper did not answer /Health within 3s");
    expect(result.output).toContain("stub container log for harper-flair");
    expect(result.output).toContain("Trying direct curl with verbose:");
    // It waited out the budget rather than failing on a poll count.
    expect(result.seconds).toBeGreaterThanOrEqual(3);
    expect(result.seconds).toBeLessThan(20);
  }, CASE_TIMEOUT_MS);
});
