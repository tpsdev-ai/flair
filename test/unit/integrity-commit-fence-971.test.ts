/**
 * integrity-commit-fence-971.test.ts — flair#971 slice 1a, invariant 7.
 *
 * Proves the commit fence on `withConfigCriticalSection`: competing writers
 * hold on the pre-scan generation, a failure before the rename leaves CURRENT
 * unchanged, a post-rename fsync warning is `commit_uncertain`, and the next
 * operation recovers a retained/uncertain generation before proceeding.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  commitGeneration,
  generationNumbers,
  generationPath,
  initializeIntegrityCustody,
  integrityPaths,
  openIntegrityState,
  type IntegrityStateOptions,
} from "../../src/lib/integrity-state.ts";

const OPERATOR_UID = process.getuid?.() ?? 0;
const SERVER_UID = OPERATOR_UID === 0 ? 65534 : OPERATOR_UID + 1000;
const MACHINE = "host-a";
const CHILD_DEADLINE_MS = 20_000;
const modulePath = join(import.meta.dirname, "..", "..", "src", "lib", "integrity-state.ts");

let root: string;
let custodyDir: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-971-fence-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  custodyDir = join(root, "custody");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(overrides: Partial<IntegrityStateOptions> = {}): IntegrityStateOptions {
  return {
    custodyDir,
    dataDir,
    serverUid: SERVER_UID,
    operatorUid: OPERATOR_UID,
    machineId: MACHINE,
    newCustody: true,
    ...overrides,
  };
}

function init(overrides: Partial<IntegrityStateOptions> = {}) {
  const result = initializeIntegrityCustody(options(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`initialization failed: ${result.reason}: ${result.detail}`);
  return result.state;
}

function payload() {
  return {
    baseline: {
      scannedAt: "2026-11-04T00:00:00.000Z",
      scanStartedAt: "2026-11-04T00:00:00.000Z",
      scanEndedAt: "2026-11-04T00:00:01.000Z",
      clockSource: "test",
      byDurability: { permanent: 1, persistent: 0, standard: 0, ephemeral: 0 },
      ids: { "mem-a": "permanent" },
      instanceTokens: { "mem-a": "tok-a" },
    },
  };
}

function commit(state = init(), expectedGeneration = 0) {
  const result = commitGeneration({ state, expectedGeneration, checkpoint: payload() });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`commit failed: ${result.reason}: ${result.detail}`);
  return result;
}

function childSource(): string {
  return [
    `import { openIntegrityState, commitGeneration } from ${JSON.stringify(modulePath)};`,
    "const [custodyDir, dataDir, serverUid, operatorUid, machineId, expected] = process.argv.slice(1);",
    "const opened = openIntegrityState({ custodyDir, dataDir, serverUid: Number(serverUid), operatorUid: Number(operatorUid), machineId, newCustody: false });",
    "if (!opened.ok) { console.log('RESULT:' + JSON.stringify(opened)); process.exit(0); }",
    "const checkpoint = { baseline: { scannedAt: '2026-11-04T00:00:00.000Z', scanStartedAt: '2026-11-04T00:00:00.000Z', scanEndedAt: '2026-11-04T00:00:01.000Z', clockSource: 'test', byDurability: { permanent: 1, persistent: 0, standard: 0, ephemeral: 0 }, ids: { 'mem-a': 'permanent' }, instanceTokens: { 'mem-a': 'tok-a' } } };",
    "const result = commitGeneration({ state: opened.state, expectedGeneration: Number(expected), checkpoint });",
    "console.log('RESULT:' + JSON.stringify(result));",
  ].join("\n");
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function startChild(barrierDir: string, expected: number): { child: ChildProcess; done: Promise<ChildResult> } {
  const child = spawn(
    process.execPath,
    ["-e", childSource(), custodyDir, dataDir, String(SERVER_UID), String(OPERATOR_UID), MACHINE, String(expected)],
    {
      env: { ...process.env, HOME: join(root, "home"), FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const done = new Promise<ChildResult>((resolve) => {
    const killer = setTimeout(() => { child.kill("SIGKILL"); }, CHILD_DEADLINE_MS);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, done };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function resultOf(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("RESULT:"));
  if (!line) throw new Error(`no RESULT line in child output: ${stdout}`);
  return JSON.parse(line.slice("RESULT:".length)) as Record<string, unknown>;
}

describe("commit-fence (invariant 7)", () => {
  it("rechecks custody when committing a generation", () => {
    const state = init();
    chmodSync(integrityPaths(custodyDir).keyPath, 0o644);
    const denied = commitGeneration({ state, expectedGeneration: 0, checkpoint: payload() });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.reason).toBe("custody_invalid");
  });

  it("commits a generation and holds a stale expected generation", () => {
    const state = init();
    const first = commitGeneration({ state, expectedGeneration: 0, checkpoint: payload() });
    expect(first).toMatchObject({ ok: true, status: "committed", generation: 1 });

    const stale = commitGeneration({ state, expectedGeneration: 0, checkpoint: payload() });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.status).toBe("commit_conflict");
    expect(stale.reason).toBe("commit_conflict");

    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.state.generation).toBe(1);
  });

  it("fails before the rename without replacing CURRENT, and a retry succeeds", () => {
    const state = init();
    commit(state, 0);
    const failed = commitGeneration({
      state,
      expectedGeneration: 1,
      checkpoint: payload(),
      testHooks: { afterFsync: () => { throw new Error("injected failure before rename"); } },
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.status).toBe("commit_failed");

    const afterFailure = openIntegrityState(options({ newCustody: false }));
    expect(afterFailure.ok).toBe(true);
    if (afterFailure.ok) expect(afterFailure.state.generation).toBe(1);

    const changedPayload = payload();
    changedPayload.baseline.scannedAt = "2026-11-04T00:05:00.000Z";
    changedPayload.baseline.scanStartedAt = "2026-11-04T00:05:00.000Z";
    changedPayload.baseline.scanEndedAt = "2026-11-04T00:05:01.000Z";
    const retry = commitGeneration({ state, expectedGeneration: 1, checkpoint: changedPayload });
    expect(retry).toMatchObject({ ok: true, status: "committed", generation: 2 });
    const afterRetry = openIntegrityState(options({ newCustody: false }));
    expect(afterRetry.ok).toBe(true);
    if (afterRetry.ok) expect(afterRetry.state.generation).toBe(2);
  });

  it("reports a post-rename directory-fsync warning as commit_uncertain, never success", () => {
    const state = init();
    commit(state, 0);
    const uncertain = commitGeneration({
      state,
      expectedGeneration: 1,
      checkpoint: payload(),
      testHooks: { afterRename: () => { throw new Error("injected post-rename fsync failure"); } },
    });
    expect(uncertain.ok).toBe(false);
    if (uncertain.ok) return;
    expect(uncertain.status).toBe("commit_uncertain");
    expect(uncertain.reason).toBe("commit_uncertain");
    expect(uncertain.committed).toBe(true);
    expect(existsSync(integrityPaths(custodyDir).uncertainPath)).toBe(true);

    const recovered = openIntegrityState(options({ newCustody: false }));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.state.generation).toBe(2);
    expect(recovered.state.recovered).toBe(true);
    expect(lstatSync(integrityPaths(custodyDir).uncertainPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("recovers CURRENT from a retained generation when the pointer is missing", () => {
    const state = init();
    commit(state, 0);
    commit(state, 1);
    unlinkSync(integrityPaths(custodyDir).currentPath);
    const recovered = openIntegrityState(options({ newCustody: false }));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.state.generation).toBe(2);
    expect(recovered.state.recovered).toBe(true);
    expect(generationNumbers(integrityPaths(custodyDir))).toEqual([1, 2]);
    expect(existsSync(integrityPaths(custodyDir).currentPath)).toBe(true);
  });

  it("races two real writers with one commit winning and one commit_conflict", async () => {
    const state = init();
    commit(state, 0);
    const barrierDir = join(root, "barrier");
    mkdirSync(barrierDir, { mode: 0o700 });

    const a = startChild(barrierDir, 1);
    const b = startChild(barrierDir, 1);
    try {
      await waitFor(() => readdirCount(barrierDir, ".preObserve") >= 2, "two pre-observe barriers");
      writeFileSync(join(barrierDir, "go.preObserve"), "1");
      await waitFor(() => readdirCount(barrierDir, ".read") >= 1, "the lock holder's read barrier");
      writeFileSync(join(barrierDir, "go.read"), "1");
      // The winner reaches the module's post-fsync crash barrier next; release
      // it so the losing writer can retry the lock inside its bounded window.
      writeFileSync(join(barrierDir, "go.fsync"), "1");

      const results = await Promise.all([a.done, b.done]);
      expect(results.map((result) => result.code)).toEqual([0, 0]);
      const parsed = results.map((result) => resultOf(result.stdout));
      const committed = parsed.filter((result) => result.status === "committed");
      const conflicts = parsed.filter((result) => result.status === "commit_conflict");
      expect(committed.length).toBe(1);
      expect(conflicts.length).toBe(1);

      const opened = openIntegrityState(options({ newCustody: false }));
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(opened.state.generation).toBe(2);
      expect(generationNumbers(integrityPaths(custodyDir))).toEqual([1, 2]);
      expect(readFileSync(generationPath(integrityPaths(custodyDir).generationsDir, 1), "utf-8").length).toBeGreaterThan(0);
    } finally {
      a.child.kill("SIGKILL");
      b.child.kill("SIGKILL");
    }
  }, 40_000);
});

function readdirCount(dir: string, suffix: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}
