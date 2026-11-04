/**
 * migrations-boot-lock-error-2978.test.ts — a refused migration-lock
 * acquisition is reported as a boot failure only when it is NOT contention
 * (flair#2978).
 *
 * The runner used to prefix every refusal `single-flight:`, and the boot path
 * treats that prefix as benign, so a mutex error that blocked the cycle was
 * skipped quietly. These tests drive the real boot entry point against a real
 * filesystem: a broken mutex must be reported with the lock's own reason,
 * while a live holder and an in-process caller stay quiet.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  _resetInProcessLockForTests,
  acquireMigrationLock,
} from "../../resources/migrations/lock.ts";
import {
  _resetProgressForTests,
  getCycleStatus,
  listMigrationProgress,
} from "../../resources/migrations/progress.ts";

/** Counts `waitForTablesReady`'s access, so a quiet boot can be observed as having run. */
let tableChecks = 0;
const table = {
  get search() {
    tableChecks++;
    return async function* () {};
  },
  get: async () => null,
};
mock.module("harper", () => {
  const noop = () => {};
  return new Proxy(
    {
      Resource: class {},
      databases: { flair: { Memory: table, Relationship: table } },
      server: { getUser: async () => null },
      logger: { info: noop, warn: noop, error: noop, debug: noop, trace: noop },
    },
    { get: (target: Record<string, unknown>, property: string) => (property in target ? target[property] : noop) },
  );
});
mock.module("../../resources/embeddings-provider.js", () => ({
  getMode: () => "local",
  getModelId: () => "hash-512d",
  getEmbedding: async () => null,
  getStatus: () => ({}),
  buildEmbedOptions: () => ({}),
  EMBEDDING_ENGINE: "gguf",
}));

let dataDir = "";
let errors: ReturnType<typeof spyOn>;
let boot: typeof import("../../resources/migration-boot.ts");
const savedEnv = { ...process.env };

const lockPath = () => join(dataDir, ".migrations", "lock");

function prepareDataDir(): void {
  dataDir = join(tempDir("flair-2978-boot-"), "data");
  mkdirSync(dataDir);
  process.env.FLAIR_MIGRATION_DATA_DIR = dataDir;
  delete process.env.HDB_ROOT;
  delete process.env.ROOTPATH;
}

function bootLog(): string {
  return errors.mock.calls.flat().join("\n");
}

/** Waits for the failure path's terminal phase. */
async function waitForCycleDone(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (getCycleStatus().phase !== "done" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(getCycleStatus().phase).toBe("done");
}

/** Waits until a newly scheduled boot has passed the table-ready gate, then lets it finish. */
async function waitForBootAttempt(): Promise<void> {
  const before = tableChecks;
  const deadline = Date.now() + 5_000;
  while (tableChecks === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(tableChecks).toBeGreaterThan(before);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(async () => {
  prepareDataDir();
  errors = spyOn(console, "error").mockImplementation(() => {});
  _resetInProcessLockForTests();
  const firstImport = boot === undefined;
  boot = await import("../../resources/migration-boot.ts");
  // The module's top-level schedule runs only on first import; let that pass
  // finish so each test starts from a quiet, reset cycle.
  if (firstImport) await waitForCycleDone();
  boot._resetMigrationBootForTests();
  _resetProgressForTests();
  _resetInProcessLockForTests();
  errors.mockClear();
});

afterEach(() => {
  boot?._resetMigrationBootForTests();
  _resetProgressForTests();
  _resetInProcessLockForTests();
  mock.restore();
  for (const key of ["FLAIR_MIGRATION_DATA_DIR", "HDB_ROOT", "ROOTPATH"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("a mutex error is reported as a boot failure naming the lock reason", async () => {
  mkdirSync(join(dataDir, ".migrations"), { recursive: true, mode: 0o700 });
  mkdirSync(`${lockPath()}.guard`, { recursive: true, mode: 0o700 });
  writeFileSync(join(`${lockPath()}.guard`, "junk.txt"), "not an owner record");

  boot.scheduleMigrationBoot();
  await waitForBootAttempt();

  const log = bootLog();
  expect(log).toContain("[flair-migrations] migration cycle did not run:");
  expect(log).toContain("lock error: MigrationLockMutexError");
  expect(log).toContain("junk.txt");
  expect(getCycleStatus().phase).toBe("done");
  expect(getCycleStatus().lastCycleError).toContain("MigrationLockMutexError");
  const failed = listMigrationProgress().filter((entry) => entry.state === "failed");
  expect(failed.length).toBeGreaterThan(0);
  for (const entry of failed) expect(entry.reason).toContain("MigrationLockMutexError");
});

test("a live holder in another process stays quiet", async () => {
  const holder = Bun.spawn(["sleep", "30"]);
  try {
    mkdirSync(join(dataDir, ".migrations"), { recursive: true, mode: 0o700 });
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: holder.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }),
    );

    boot.scheduleMigrationBoot();
    await waitForBootAttempt();

    expect(existsSync(`${lockPath()}.guard`), "the cycle reached the lock mutex").toBe(true);
    expect(bootLog()).not.toContain("[flair-migrations]");
    expect(getCycleStatus().lastCycleError ?? null).toBeNull();
    expect(listMigrationProgress().filter((entry) => entry.state === "failed")).toEqual([]);
  } finally {
    holder.kill();
    await holder.exited;
  }
});

test("a caller already holding the lock in this process stays quiet", async () => {
  const held = acquireMigrationLock({ lockPath: lockPath() });
  expect(held.acquired).toBe(true);
  try {
    boot.scheduleMigrationBoot();
    await waitForBootAttempt();

    expect(bootLog()).not.toContain("[flair-migrations]");
    expect(getCycleStatus().lastCycleError ?? null).toBeNull();
    expect(listMigrationProgress().filter((entry) => entry.state === "failed")).toEqual([]);
  } finally {
    if (held.acquired) held.release();
  }
});

test("only the single-flight prefix is benign", () => {
  expect(boot.isBenignSkip("single-flight: held by pid 1 on host-a since then")).toBe(true);
  expect(boot.isBenignSkip("lock error: MigrationLockMutexError: it cannot be inspected")).toBe(false);
  expect(boot.isBenignSkip("nothing pending")).toBe(true);
});
