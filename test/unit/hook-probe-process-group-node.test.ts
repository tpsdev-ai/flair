/** Non-Windows test cases. */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "src", "doctor-client.ts");
const NODE_CHILD_TIMEOUT_MS = 20_000;
const CASE_BUDGET_MS = 30_000;

const RECORD_PGID = `printf '%s' "$$" > "$FLAIR_PROBE_RECORD_DIR/pgid"`;
const RECORD_CHILD = `printf '%s' "$!" > "$FLAIR_PROBE_RECORD_DIR/child"`;

const RUNNER = `
import { pathToFileURL } from "node:url";
const [bundle, mode, recDir] = process.argv.slice(2);
const probe = await import(pathToFileURL(bundle).href);
process.env.FLAIR_PROBE_RECORD_DIR = recDir;
const commands = {
  timeout: [${JSON.stringify(`sleep 60 & ${RECORD_PGID}; ${RECORD_CHILD}; wait`)}, 800],
  "normal-exit": [${JSON.stringify(`sleep 60 & ${RECORD_PGID}; ${RECORD_CHILD}`)}, 8000],
  "no-child": [${JSON.stringify(`${RECORD_PGID}; printf '{}'`)}, 8000],
};
const outcome = mode === "spawn-failure"
  ? probe.runProbeInOwnGroup("true", 8000, { input: "", env: { OVERSIZED: "a".repeat(8000000) } })
  : probe.probeSessionStartHookDelivery(commands[mode][0], { timeoutMs: commands[mode][1] });
console.log("RESULT=" + JSON.stringify({ outcome, bun: typeof globalThis.Bun !== "undefined", node: process.versions.node }));
`;

let workDir = "";
let bundlePath = "";
let runnerPath = "";
const recordDirs: string[] = [];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "flair-probe-node-"));
  const built = await Bun.build({ entrypoints: [SRC], target: "node", format: "esm", outdir: join(workDir, "bundle") });
  expect(built.success).toBe(true);
  expect(built.outputs.length).toBe(1);
  bundlePath = built.outputs[0].path;
  runnerPath = join(workDir, "runner.mjs");
  writeFileSync(runnerPath, RUNNER, "utf-8");
}, CASE_BUDGET_MS);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const dir of recordDirs.splice(0)) {
    for (const name of ["pgid", "child"]) {
      let pid = 0;
      try {
        pid = Number(readFileSync(join(dir, name), "utf-8").trim());
      } catch {
      }
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

interface NodeProbeResult {
  outcome: {
    exitCode: number | null;
    stdout: string;
    timedOut: boolean;
    spawnError: string | null;
    cleanupError?: string | null;
    outputOverflow?: boolean;
  };
  bun: boolean;
  node: string;
}

function runUnderNode(mode: string): { result: NodeProbeResult; recDir: string } {
  const recDir = mkdtempSync(join(tmpdir(), "flair-probe-rec-"));
  recordDirs.push(recDir);
  const r = spawnSync("node", [runnerPath, bundlePath, mode, recDir], { encoding: "utf-8", timeout: NODE_CHILD_TIMEOUT_MS });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(0);
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT=")) ?? "";
  expect(line.startsWith("RESULT=")).toBe(true);
  const result = JSON.parse(line.slice("RESULT=".length)) as NodeProbeResult;
  expect(result.bun).toBe(false);
  expect(result.node.length).toBeGreaterThan(0);
  return { result, recDir };
}

function recordedInt(dir: string, name: string): number {
  const value = Number(readFileSync(join(dir, name), "utf-8").trim());
  expect(Number.isInteger(value) && value > 1).toBe(true);
  return value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("flair#2385 — under Node, the hook-status probe's process-group cleanup", () => {
  it(
    "on the timeout path, no process from the group the command started is alive",
    () => {
      const { result, recDir } = runUnderNode("timeout");
      expect(result.outcome.timedOut).toBe(true);
      expect(result.outcome.cleanupError ?? null).toBeNull();
      const pgid = recordedInt(recDir, "pgid");
      const child = recordedInt(recDir, "child");
      expect(processAlive(child)).toBe(false);
      expect(groupAlive(pgid)).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  it(
    "after a normal exit, no process from the group the command started is alive",
    () => {
      const { result, recDir } = runUnderNode("normal-exit");
      expect(result.outcome.timedOut).toBe(false);
      expect(result.outcome.exitCode).toBe(0);
      expect(result.outcome.cleanupError ?? null).toBeNull();
      const pgid = recordedInt(recDir, "pgid");
      const child = recordedInt(recDir, "child");
      expect(processAlive(child)).toBe(false);
      expect(groupAlive(pgid)).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  it(
    "a command that leaves no child keeps its ordinary outcome and its group is gone",
    () => {
      const { result, recDir } = runUnderNode("no-child");
      expect(result.outcome).toMatchObject({ exitCode: 0, stdout: "{}", timedOut: false, spawnError: null, cleanupError: null, outputOverflow: false });
      expect(groupAlive(recordedInt(recDir, "pgid"))).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  it(
    "a spawn that fails reports the spawn error and no process-group error",
    () => {
      const { result } = runUnderNode("spawn-failure");
      expect(result.outcome.spawnError).toContain("E2BIG");
      expect(result.outcome.cleanupError ?? null).toBeNull();
    },
    CASE_BUDGET_MS,
  );
});
