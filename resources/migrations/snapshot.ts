/**
 * snapshot.ts — risk-scoped pre-flight snapshot (ladder step 3) + retention
 * pruning (ladder... well, invariant III's retention rule, applied after a
 * successful completion gate).
 *
 * This is a LOGICAL, in-process snapshot — deliberately NOT the same
 * mechanism as `flair snapshot create` (src/cli.ts's createDataSnapshot),
 * which takes a byte-exact tar.gz of the whole data directory but requires
 * STOPPING Harper first for consistency. The zero-touch runner executes
 * INSIDE the live-serving Harper process (boot-keyed, server ready first —
 * see resources/MigrationBoot.ts), so stopping the server to snapshot
 * itself is a non-starter; this writes a small, risk-class-scoped JSON/JSONL
 * manifest instead, using the same file-safety discipline (0700 dirs, 0600
 * files, stat-verified — see dir-safety.ts) as the rest of Flair's snapshot
 * machinery.
 *
 * Scope per risk class (~/ops/FLAIR-MIGRATION-SAFETY.md, space-pressure
 * step 3 / resources/migrations/risk-policy.ts):
 *   - metadata-only:      manifest only (row counts, versions) — no corpus
 *                          snapshot needed; derived data is recomputable by
 *                          definition (invariant I).
 *   - schema+metadata:    manifest + a schema summary (table/field names,
 *                          never row data) — no row rewrites happen, so
 *                          there's nothing to snapshot beyond proving what
 *                          shape existed before the migration.
 *   - pointers+metadata:  manifest + a JSONL of POINTER fields only (id,
 *                          supersedes, validFrom, validTo) for touched rows
 *                          — never content. Content-transform migrations use
 *                          native supersession (old rows retained in-store,
 *                          never mutated), so the corpus itself doesn't need
 *                          snapshotting; only the pointer state that proves
 *                          which rows were touched and how they chain.
 */
import { statSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureSecureDir, writeSecureFile } from "./dir-safety.js";
import type { SnapshotScope } from "./risk-policy.js";

export interface SnapshotDeps {
  snapshotRoot: string;
  now: () => Date;
}

export interface PointerRow {
  id: string;
  supersedes?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface CreateMigrationSnapshotOpts {
  migrationId: string;
  scope: SnapshotScope;
  rowCounts: Record<string, number>;
  fromVersion: string;
  toVersion: string;
  /** Only used when scope === "schema+metadata": table -> field list (names only, never data). */
  schema?: Record<string, string[]>;
  /** Only used when scope === "pointers+metadata": pointer-only rows for touched ids. */
  pointers?: PointerRow[];
}

export interface SnapshotResult {
  dir: string;
  manifestPath: string;
  bytes: number;
}

function sanitizeIdPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Creates the risk-scoped snapshot under `deps.snapshotRoot/<migrationId>-<iso>/`. */
export function createMigrationSnapshot(opts: CreateMigrationSnapshotOpts, deps: SnapshotDeps): SnapshotResult {
  const now = deps.now();
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const dir = join(deps.snapshotRoot, `${sanitizeIdPart(opts.migrationId)}-${iso}`);
  ensureSecureDir(dir);

  const manifest = {
    migrationId: opts.migrationId,
    scope: opts.scope,
    createdAt: now.toISOString(),
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    rowCounts: opts.rowCounts,
  };
  const manifestPath = join(dir, "manifest.json");
  writeSecureFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", dir);
  let bytes = statSync(manifestPath).size;

  if (opts.scope === "schema+metadata" && opts.schema) {
    const p = join(dir, "schema.json");
    writeSecureFile(p, JSON.stringify(opts.schema, null, 2) + "\n", dir);
    bytes += statSync(p).size;
  }

  if (opts.scope === "pointers+metadata" && opts.pointers) {
    const p = join(dir, "pointers.jsonl");
    const body = opts.pointers.map((r) => JSON.stringify(r)).join("\n") + (opts.pointers.length ? "\n" : "");
    writeSecureFile(p, body, dir);
    bytes += statSync(p).size;
  }

  return { dir, manifestPath, bytes };
}

interface SnapshotDirEntry {
  path: string;
  mtimeMs: number;
}

function listMigrationSnapshotDirs(snapshotRoot: string): SnapshotDirEntry[] {
  let names: string[];
  try {
    names = readdirSync(snapshotRoot);
  } catch {
    return [];
  }
  const out: SnapshotDirEntry[] = [];
  for (const name of names) {
    const path = join(snapshotRoot, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) out.push({ path, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  return out;
}

export const DEFAULT_SNAPSHOT_KEEP_LAST = 3;
export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * Retention (Kern verdict): "keep-last-3 floor AND 30-day age ceiling, more
 * permissive wins." Implemented as a UNION of both rules — a snapshot
 * survives if EITHER "among the 3 most recent" OR "younger than 30 days" is
 * true; only a snapshot that fails BOTH gets pruned. This is the
 * more-permissive (keeps more, never less) interpretation: the last-3 floor
 * alone would prune a 2-day-old 4th snapshot; the union keeps it.
 */
export function pruneMigrationSnapshots(
  snapshotRoot: string,
  opts: { keepLast?: number; maxAgeMs?: number; now?: () => number } = {},
): string[] {
  const keepLast = opts.keepLast ?? DEFAULT_SNAPSHOT_KEEP_LAST;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
  const nowMs = (opts.now ?? Date.now)();

  const all = listMigrationSnapshotDirs(snapshotRoot).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set<string>();
  for (const e of all.slice(0, keepLast)) keep.add(e.path);
  for (const e of all) {
    if (nowMs - e.mtimeMs <= maxAgeMs) keep.add(e.path);
  }

  const removed: string[] = [];
  for (const e of all) {
    if (!keep.has(e.path)) {
      try {
        rmSync(e.path, { recursive: true, force: true });
        removed.push(e.path);
      } catch {
        /* best-effort — a prune failure must never fail an otherwise-successful migration */
      }
    }
  }
  return removed;
}
