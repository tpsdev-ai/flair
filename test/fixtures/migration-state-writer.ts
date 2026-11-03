/**
 * Child-process writer for test/integration/migrations-state-writers-2866*.test.ts.
 *
 * Takes the real migration lock, writes one real state entry, then reports to
 * the test through marker files and, optionally, waits with the lock still
 * held. Separate processes are what make the interleaving real: the in-process
 * mutex cannot stand in for two runners.
 *
 * argv: <statePath> <id> <markerDir> [holdUntil] [mode]
 *   mode "write" (default) — write, then hold until `holdUntil` if given.
 *   mode "touch" — write, hold until `holdUntil`, then call touch().
 *   mode "release" — write, hold until `holdUntil`, then call release().
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireMigrationLock } from "../../resources/migrations/lock.ts";
import { writeMigrationStateEntry } from "../../resources/migrations/state.ts";

const [statePath, id, markerDir, holdUntil, mode = "write"] = process.argv.slice(2);
if (!statePath || !id || !markerDir) {
  throw new Error("usage: migration-state-writer <statePath> <id> <markerDir> [holdUntil] [mode]");
}

async function waitForMarker(name: string, timeoutMs = 15_000): Promise<boolean> {
  const path = join(markerDir as string, name);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

const lock = acquireMigrationLock({ lockPath: join(dirname(statePath), "lock") });
if (!lock.acquired) {
  writeFileSync(join(markerDir, `lock-failed.${id}`), lock.reason);
  process.exit(3);
}

try {
  await writeMigrationStateEntry(
    statePath,
    id,
    { lastOutcome: "success", completedAtVersion: "writer-2866", completedAt: "2026-01-01T00:00:00.000Z" },
    lock,
  );
  writeFileSync(join(markerDir, `written.${id}`), "");
  if (holdUntil) {
    if (!(await waitForMarker(holdUntil))) {
      writeFileSync(join(markerDir, `hold-timeout.${id}`), "");
      process.exitCode = 4;
    }
  }
  if (mode === "touch") {
    lock.touch();
    writeFileSync(join(markerDir, `touched.${id}`), "");
  } else if (mode === "release") {
    lock.release();
    writeFileSync(join(markerDir, `released.${id}`), "");
  }
} catch (err) {
  writeFileSync(join(markerDir, `refused.${id}`), `${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 2;
} finally {
  lock.release();
}
