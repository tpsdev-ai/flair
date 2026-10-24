/**
 * boot-progress.ts — the boot path's single data-dir resolution (flair#2840).
 *
 * `seedBootProgress` resolves the writable migration data dir once and records
 * the result with `noteSelectedMigrationDataDir`. When a directory is usable,
 * `resolveMigrationDataDirForRead` (which /HealthDetail uses) returns it from
 * then on, and progress is seeded from that directory's state file.
 * resources/migration-boot.ts calls it when it schedules the boot and runs its
 * cycles against the same result. It lives outside migration-boot.ts so a test
 * can call it without scheduling a boot.
 */
import { noteSelectedMigrationDataDir, resolveWritableMigrationDataDir, type ResolvedMigrationDataDir } from "./data-dir.js";
import { seedIdleProgress, seedProgressFromState } from "./progress.js";
import { defaultStatePath } from "./state.js";

/** With no usable directory, no state file is read: ids without an entry are
 *  seeded `idle`. */
export function seedBootProgress(ids: readonly string[], env: NodeJS.ProcessEnv = process.env): ResolvedMigrationDataDir {
  const resolved = resolveWritableMigrationDataDir(env);
  noteSelectedMigrationDataDir(resolved.dataDir);
  if (resolved.dataDir) seedProgressFromState(defaultStatePath(resolved.dataDir), ids);
  else seedIdleProgress(ids);
  return resolved;
}
