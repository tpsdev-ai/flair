/**
 * integrity-commit-fence-971.test.ts — flair#971 slice 1a, invariant 7.
 *
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
  symlinkSync,
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
  machineIdentity,
  openIntegrityState,
  tombstoneEnrollment,
  type IntegrityStateOptions,
} from "../../src/lib/integrity-state.ts";

const OPERATOR_UID = process.getuid?.() ?? 0;
const SERVER_UID = OPERATOR_UID === 0 ? 65534 : OPERATOR_UID + 1000;
const MACHINE = machineIdentity();
const CHILD_DEADLINE_MS = 20_000;
const modulePath = join(import.meta.dirname, "..", "..", "src", "lib", "integrity-state.ts");

let root: string;
let custodyDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-971-fence-"));
  custodyDir = join(root, "custody");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(overrides: Partial<IntegrityStateOptions> = {}): IntegrityStateOptions {
  return {
    custodyDir,
    serverUid: SERVER_UID,
    serverUidSource: "measured",
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
    "const [custodyDir, serverUid, operatorUid, machineId, expected] = process.argv.slice(1);",
    "const opened = openIntegrityState({ custodyDir, serverUid: Number(serverUid), serverUidSource: \"measured\", operatorUid: Number(operatorUid), machineId, newCustody: false });",
    "if (!opened.ok) { console.log('RESULT:' + JSON.stringify(opened)); process.exit(0); }",
    "const checkpoint = { baseline: { scannedAt: '2026-11-04T00:00:00.000Z', scanStartedAt: '2026-11-04T00:00:00.000Z', scanEndedAt: '2026-11-04T00:00:01.000Z', clockSource: 'test', byDurability: { permanent: 1, persistent: 0, standard: 0, ephemeral: 0 }, ids: { 'mem-a': 'permanent' }, instanceTokens: { 'mem-a': 'tok-a' } } };",
    "const result = commitGeneration({ state: opened.state, expectedGeneration: Number(expected), checkpoint });",
    "console.log('RESULT:' + JSON.stringify(result));",
  ].join("\n");
}

function tombstoneChildSource(): string {
  return [
    `import { tombstoneEnrollment } from ${JSON.stringify(modulePath)};`,
    "const [custodyDir, serverUid, operatorUid, machineId, expectedSequence] = process.argv.slice(1);",
    "const result = tombstoneEnrollment({ custodyDir, serverUid: Number(serverUid), serverUidSource: 'measured', operatorUid: Number(operatorUid), machineId, newCustody: false, expectedSequence: Number(expectedSequence) });",
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
    ["-e", childSource(), custodyDir, String(SERVER_UID), String(OPERATOR_UID), MACHINE, String(expected)],
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

function startTombstoneChild(expectedSequence: number): { child: ChildProcess; done: Promise<ChildResult> } {
  const child = spawn(
    process.execPath,
    ["-e", tombstoneChildSource(), custodyDir, String(SERVER_UID), String(OPERATOR_UID), MACHINE, String(expectedSequence)],
    {
      env: { ...process.env, HOME: join(root, "home") },
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

  it("reports a hook throw before directory fsync as commit_uncertain", () => {
    const state = init();
    commit(state, 0);
    const uncertain = commitGeneration({
      state,
      expectedGeneration: 1,
      checkpoint: payload(),
      testHooks: { afterRename: () => { throw new Error("injected hook failure before directory fsync"); } },
    });
    expect(uncertain.ok).toBe(false);
    if (uncertain.ok) return;
    expect(uncertain.status).toBe("commit_uncertain");
    expect(uncertain.reason).toBe("commit_uncertain");
    expect(uncertain.committed).toBe(true);
    expect(readFileSync(integrityPaths(custodyDir).uncertainPath, "utf-8")).toBe("commit:2");

    const recovered = openIntegrityState(options({ newCustody: false }));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.state.generation).toBe(2);
    expect(recovered.state.recovered).toBe(true);
    expect(lstatSync(integrityPaths(custodyDir).uncertainPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("retains uncertain intent on a same-handle retry until recovered open", () => {
    const state = init();
    commit(state, 0);
    const uncertain = commitGeneration({
      state, expectedGeneration: 1, checkpoint: payload(),
      testHooks: { afterRename: () => { throw new Error("injected post-rename failure"); } },
    });
    expect(uncertain).toMatchObject({ ok: false, reason: "commit_uncertain", generation: 2 });
    const retry = commitGeneration({ state, expectedGeneration: 2, checkpoint: payload() });
    expect(readFileSync(integrityPaths(custodyDir).uncertainPath, "utf-8")).toBe("commit:2");
    expect(retry).toMatchObject({ ok: false, reason: "commit_uncertain" });
    expect(generationNumbers(integrityPaths(custodyDir))).toEqual([1, 2]);
    const recovered = openIntegrityState(options({ newCustody: false }));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.state.recovered).toBe(true);
    expect(recovered.state.generation).toBe(2);
    expect(existsSync(integrityPaths(custodyDir).uncertainPath)).toBe(false);
    expect(commitGeneration({ state: recovered.state, expectedGeneration: 2, checkpoint: payload() }).ok).toBe(true);
  });

  it("refuses to publish a retained generation when CURRENT is missing", () => {
    const state = init();
    commit(state, 0);
    commit(state, 1);
    unlinkSync(integrityPaths(custodyDir).currentPath);
    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe("custody_invalid");
    expect(existsSync(integrityPaths(custodyDir).currentPath)).toBe(false);
  });

  it("refuses a commit on a live handle when CURRENT is deleted", () => {
    const state = init();
    commit(state, 0);
    const paths = integrityPaths(custodyDir);
    const publishedGeneration = readFileSync(generationPath(paths.generationsDir, 1), "utf-8");
    unlinkSync(paths.currentPath);
    const changed = payload();
    changed.baseline.scannedAt = "2026-11-04T00:05:00.000Z";
    changed.baseline.scanStartedAt = "2026-11-04T00:05:00.000Z";
    changed.baseline.scanEndedAt = "2026-11-04T00:05:01.000Z";
    // A scan that started before generation one: with CURRENT gone, this
    // expectation must not be read as an empty history.
    const result = commitGeneration({ state, expectedGeneration: 0, checkpoint: changed });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("custody_invalid");
    expect(existsSync(paths.currentPath)).toBe(false);
    expect(generationNumbers(paths)).toEqual([1]);
    expect(readFileSync(generationPath(paths.generationsDir, 1), "utf-8")).toBe(publishedGeneration);
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

  it("refuses a generation staged by a failed first commit", () => {
    const state = init();
    const failed = commitGeneration({
      state,
      expectedGeneration: 0,
      checkpoint: payload(),
      testHooks: { afterFsync: () => { throw new Error("injected failure before the first rename"); } },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.status).toBe("commit_failed");
    const paths = integrityPaths(custodyDir);
    expect(existsSync(paths.currentPath)).toBe(false);
    expect(generationNumbers(paths)).toEqual([1]);
    expect(existsSync(paths.uncertainPath)).toBe(false);

    const reopened = openIntegrityState(options({ newCustody: false }));
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) expect(reopened.reason).toBe("custody_invalid");
    expect(existsSync(paths.currentPath)).toBe(false);
    expect(generationNumbers(paths)).toEqual([1]);
  });

  it("refuses to publish when the uncertainty marker write fails after the decision", () => {
    const state = init();
    commit(state, 0);
    const paths = integrityPaths(custodyDir);
    const published = readFileSync(paths.currentPath, "utf-8");
    const changed = payload();
    changed.baseline.scannedAt = "2026-11-04T00:05:00.000Z";
    changed.baseline.scanStartedAt = "2026-11-04T00:05:00.000Z";
    changed.baseline.scanEndedAt = "2026-11-04T00:05:01.000Z";
    const result = commitGeneration({
      state,
      expectedGeneration: 1,
      checkpoint: changed,
      testHooks: { beforeUncertainMarkerWrite: () => { throw new Error("injected marker write failure"); } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("commit_failed");
    expect(result.detail).toContain("target was not replaced; staged files may remain");
    expect(readFileSync(paths.currentPath, "utf-8")).toBe(published);
    // The generation was staged, so the marker write is the step that failed.
    expect(generationNumbers(paths)).toEqual([1, 2]);
    expect(existsSync(paths.uncertainPath)).toBe(false);
  });

  it("retains a pre-existing marker entry when exclusive creation fails", () => {
    const state = init();
    const paths = integrityPaths(custodyDir);
    symlinkSync(join(root, "absent-marker-target"), paths.uncertainPath);
    const result = commitGeneration({ state, expectedGeneration: 0, checkpoint: payload() });
    expect(lstatSync(paths.uncertainPath).isSymbolicLink()).toBe(true);
    expect(result).toMatchObject({ ok: false, status: "commit_failed" });
    expect(existsSync(paths.currentPath)).toBe(false);
  });

  it("keeps the registry intent marker when the tombstone's pre-fsync hook throws", () => {
    const state = init();
    commit(state, 0);
    const result = tombstoneEnrollment({
      ...options({ newCustody: false }),
      expectedSequence: 1,
      testHooks: { afterRename: () => { throw new Error("injected registry pre-fsync hook failure"); } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("commit_uncertain");
    expect(readFileSync(integrityPaths(custodyDir).uncertainPath, "utf-8")).toBe("registry:2");

    const opened = openIntegrityState(options({ newCustody: false }));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe("custody_invalid");
    expect(lstatSync(integrityPaths(custodyDir).uncertainPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("orders a tombstone after a commit that holds the one custody lock", async () => {
    const state = init();
    commit(state, 0);
    const barrierDir = join(root, "barrier");
    mkdirSync(barrierDir, { mode: 0o700 });
    writeFileSync(join(barrierDir, "go.preObserve"), "1");
    writeFileSync(join(barrierDir, "go.read"), "1");
    const commitChild = startChild(barrierDir, 1);
    let tombstoneChild: ReturnType<typeof startTombstoneChild> | null = null;
    try {
      await waitFor(() => readdirCount(barrierDir, ".fsync") >= 1, "the commit's pre-rename barrier");
      tombstoneChild = startTombstoneChild(1);
      await new Promise((resolve) => setTimeout(resolve, 700));

      // The commit holds the ONE custody lock, so the tombstone cannot land
      // underneath it.
      const during = JSON.parse(readFileSync(integrityPaths(custodyDir).registryPath, "utf-8")) as {
        sequence: number;
        entries: Array<{ status: string }>;
      };
      expect(during.sequence).toBe(1);
      expect(during.entries.map((entry) => entry.status)).toEqual(["active"]);

      writeFileSync(join(barrierDir, "go.fsync"), "1");
      const [committed, tombstoned] = await Promise.all([commitChild.done, tombstoneChild.done]);
      expect(committed.code).toBe(0);
      expect(tombstoned.code).toBe(0);
      expect(resultOf(committed.stdout)).toMatchObject({ ok: true, status: "committed", generation: 2 });
      expect(resultOf(tombstoned.stdout)).toMatchObject({ ok: true, sequence: 2 });
    } finally {
      commitChild.child.kill("SIGKILL");
      tombstoneChild?.child.kill("SIGKILL");
    }
  }, 40_000);

  it("refuses a commit when the host identity differs from the supplied identity", () => {
    const state = init({ machineId: "host-a" });
    const result = commitGeneration({ state, expectedGeneration: 0, checkpoint: payload() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("custody_invalid");
    expect(generationNumbers(integrityPaths(custodyDir))).toEqual([]);
  });

  it("refuses a checkpoint payload that is not plain JSON before staging", () => {
    const state = init();
    const result = commitGeneration({
      state,
      expectedGeneration: 0,
      checkpoint: { ...payload(), pendingEvents: [undefined] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("checkpoint_incompatible");
    expect(generationNumbers(integrityPaths(custodyDir))).toEqual([]);
    expect(existsSync(integrityPaths(custodyDir).currentPath)).toBe(false);
  });

  it("refuses a negative durability count before staging", () => {
    const state = init();
    const checkpoint = payload();
    checkpoint.baseline.byDurability.permanent = -1;
    const result = commitGeneration({ state, expectedGeneration: 0, checkpoint });
    expect(result).toMatchObject({ ok: false, reason: "checkpoint_incompatible" });
    const paths = integrityPaths(custodyDir);
    expect(readdirSync(paths.generationsDir)).toEqual([]);
    expect(existsSync(paths.currentPath)).toBe(false);
    expect(existsSync(paths.uncertainPath)).toBe(false);
  });

  it("refuses a present empty CURRENT before the first generation", () => {
    const state = init();
    const paths = integrityPaths(custodyDir);
    writeFileSync(paths.currentPath, "", { mode: 0o600 });
    const result = commitGeneration({ state, expectedGeneration: 0, checkpoint: payload() });
    expect(result).toMatchObject({ ok: false, reason: "tampered" });
    expect(readFileSync(paths.currentPath, "utf-8")).toBe("");
    expect(readdirSync(paths.generationsDir)).toEqual([]);
    expect(existsSync(paths.uncertainPath)).toBe(false);
    expect(openIntegrityState(options({ newCustody: false }))).toMatchObject({ ok: false, reason: "tampered" });
  });

  it("refuses a changing getter before committing a checkpoint", () => {
    const state = init();
    let reads = 0;
    const checkpoint = payload();
    Object.defineProperty(checkpoint.baseline.ids, "mem-a", {
      enumerable: true,
      get: () => ++reads === 1 ? "permanent" : "standard",
    });
    const result = commitGeneration({ state, expectedGeneration: 0, checkpoint });
    expect(result).toMatchObject({ ok: false, reason: "checkpoint_incompatible" });
    expect(reads).toBe(0);
    expect(generationNumbers(integrityPaths(custodyDir))).toEqual([]);
    expect(existsSync(integrityPaths(custodyDir).currentPath)).toBe(false);
    const reopened = openIntegrityState(options({ newCustody: false }));
    expect(reopened).toMatchObject({ ok: false, reason: "checkpoint_missing" });
  });

  it("commits a snapshot of changing property descriptors", () => {
    const state = init();
    let reads = 0;
    const event = new Proxy({ value: 0 }, {
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, writable: true, value: ++reads }),
    });
    const result = commitGeneration({ state, expectedGeneration: 0, checkpoint: { ...payload(), pendingEvents: [event] } });
    expect(result.ok).toBe(true);
    const reopened = openIntegrityState(options({ newCustody: false }));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.state.checkpoint?.pendingEvents).toEqual([{ value: 1 }]);
    expect(reads).toBe(1);
  });

  it("round-trips a committed checkpoint through JSON and reopens", () => {
    const state = init();
    commit(state, 0);
    const path = generationPath(integrityPaths(custodyDir).generationsDir, 1);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { generation: number };
    expect(parsed.generation).toBe(1);
    const reopened = openIntegrityState(options({ newCustody: false }));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.state.checkpoint?.generation).toBe(1);
  });
});

function readdirCount(dir: string, suffix: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}
