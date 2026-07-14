/**
 * space.ts — pre-flight space check, step 1 of the ladder
 * (flair#695, "Space pressure"):
 *
 * "Pre-flight space check before any write — estimate snapshot size AND the
 * migration's own working set (supersession transforms temporarily hold
 * old+new ≈ 2× for touched tables) vs free disk, with a headroom floor
 * (never fill past ~90% — a full disk bricks Harper itself)."
 *
 * Kern verdict: "Space estimate includes HNSW rebuild overhead (re-embed
 * rewrites every vector → index rebuild can be 2–3× raw vector size):
 * snapshot + new vectors + index overhead vs headroom floor." —
 * `estimateWorkingSetBytes` below is the caller's job (the runner computes
 * it per risk class); this module just evaluates the estimate against real
 * (or test-overridden) disk free/total space.
 *
 * flair#720 rewrote the rule this module enforces. The original shape
 * (`projectedUsedFraction <= 0.9`, measured against TOTAL disk size) was
 * designed for a flair-dedicated volume, but on a general-purpose machine
 * — a personal Mac especially, where APFS purgeable space makes
 * `statfs.bavail` understate real availability — the system volume
 * routinely sits above 90% used already, so the fraction test failed
 * before a single byte was written, regardless of how trivially the
 * migration's own footprint fit (flair#720: 220 KB needed, 18.6 GB free,
 * halted anyway). The fix keeps invariant III's "never fill past a
 * cushion" intent but measures the migration's OWN impact plus an
 * absolute reserve, instead of the disk's pre-existing fullness:
 * `ok = neededBytes <= freeBytes AND (freeBytes - neededBytes) >= reserve`.
 * See `RESERVE_MIN_BYTES` / `RESERVE_MAX_BYTES` / `RESERVE_FRACTION` below
 * for how `reserve` is derived.
 */
import { statfsSync } from "node:fs";

/**
 * Reserve floor: on any disk, no migration may leave less than this much
 * free afterward, even on a tiny volume where 5% of total would be less.
 * 256 MiB is comfortably more than any single migration's own working set
 * in this codebase (the largest estimate is embedding/HNSW rebuild
 * overhead, a few KB per row) — it exists to leave room for Harper's own
 * ordinary operation (WAL, temp files, log growth), not the migration
 * itself.
 */
export const RESERVE_MIN_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * Reserve cap: on a large disk, 5% of total would be an unreasonably large
 * cushion to demand (e.g. 50 GB on a 1 TB drive) for what is, worst case,
 * a few GB of migration working set. 2 GiB caps the reserve so the rule
 * stays proportionate to what migrations actually need, not the disk's
 * raw size.
 */
export const RESERVE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Between the floor and the cap, the reserve scales with disk size: 5% of
 * total. This is the "proportionate cushion" middle ground — big enough to
 * matter on a mid-size disk, small enough not to dominate on either
 * extreme (RESERVE_MIN_BYTES / RESERVE_MAX_BYTES clamp the two ends).
 */
export const RESERVE_FRACTION = 0.05;

/**
 * Production escape hatch for constrained deployments (flair#720) — e.g. a
 * small dedicated volume where even the 256 MiB floor is more cushion than
 * the operator can spare. When set to a finite, non-negative number, this
 * overrides the computed reserve entirely (including the floor/cap clamp
 * — set it to 0 to disable the reserve check outright, keeping only the
 * `neededBytes <= freeBytes` fit test). Invalid values (non-numeric,
 * negative, NaN, Infinity) are ignored and the computed reserve is used
 * instead — mirrors TEST_FREE_BYTES_ENV's validation below. Unset (the
 * default) in every normal deployment.
 */
export const RESERVE_BYTES_ENV = "FLAIR_MIGRATION_RESERVE_BYTES";

/**
 * Test-only escape hatch: when set, overrides the real statfs-reported free
 * byte count. Used by the halt-on-blocked-space integration test (real
 * Harper spawned as a child process — the test can't inject a JS dependency
 * into that process, only environment variables) to force the ladder's
 * step-1 check to fail deterministically without needing an actually-full
 * disk. Unset (the default) in every real deployment, so this is inert in
 * production.
 */
export const TEST_FREE_BYTES_ENV = "FLAIR_MIGRATION_TEST_FREE_BYTES";

function realGetFreeBytes(dataDir: string): number {
  const override = process.env[TEST_FREE_BYTES_ENV];
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const st = statfsSync(dataDir);
  return st.bavail * st.bsize;
}

function realGetTotalBytes(dataDir: string): number {
  const st = statfsSync(dataDir);
  return st.blocks * st.bsize;
}

export interface SpaceProbe {
  getFreeBytes(dataDir: string): number;
  getTotalBytes(dataDir: string): number;
}

export const defaultSpaceProbe: SpaceProbe = {
  getFreeBytes: realGetFreeBytes,
  getTotalBytes: realGetTotalBytes,
};

/**
 * Resolves the absolute reserve a migration must leave free afterward:
 * `RESERVE_BYTES_ENV` if set to a valid (finite, >= 0) value, else
 * `clamp(RESERVE_FRACTION * totalBytes, RESERVE_MIN_BYTES, RESERVE_MAX_BYTES)`.
 * Exported so tests can exercise the clamp/override logic directly without
 * going through a full `checkSpace` call.
 */
export function resolveReserveBytes(totalBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = env[RESERVE_BYTES_ENV];
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const fractional = totalBytes * RESERVE_FRACTION;
  return Math.min(RESERVE_MAX_BYTES, Math.max(RESERVE_MIN_BYTES, fractional));
}

/**
 * Bytes → human readable (binary-based thresholds, decimal labels — same
 * convention as src/render.ts's `humanBytes`, which this module can't
 * import: resources/**\/*.ts and src/**\/*.ts are separate TypeScript
 * project boundaries (tsconfig.json vs tsconfig.cli.json/tsconfig.check.src.json)
 * — resources/ is Harper-loaded component code and never imports from the
 * CLI's src/ tree. Small enough to duplicate locally rather than restructure
 * the module boundary for one formatter.
 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface SpaceCheckInput {
  dataDir: string;
  /** Estimated bytes the snapshot (scoped to risk class) will consume. */
  estimatedSnapshotBytes: number;
  /**
   * Estimated bytes the migration's own working set needs beyond the
   * snapshot — e.g. HNSW rebuild overhead (2-3x raw vector size) for a
   * re-embed, or old+new row duplication for a content-transform. 0 for a
   * migration with no extra working-set footprint.
   */
  estimatedWorkingSetBytes: number;
}

export interface SpaceCheckResult {
  ok: boolean;
  freeBytes: number;
  totalBytes: number;
  neededBytes: number;
  /** The absolute reserve (see RESERVE_MIN_BYTES/MAX_BYTES/FRACTION) that must remain free after neededBytes is spent. */
  reserveBytes: number;
  reason?: string;
}

/**
 * Evaluates the pre-flight space check (flair#720's rule): fails (ok:false)
 * if the needed bytes don't fit in free space outright, OR if spending them
 * would leave less than `reserveBytes` free afterward. Unlike the rule this
 * replaced, fullness that already exists on the disk before the migration
 * runs is irrelevant — only the migration's OWN impact on free space is
 * judged, against an absolute (not fraction-of-total) cushion.
 */
export function checkSpace(input: SpaceCheckInput, probe: SpaceProbe = defaultSpaceProbe): SpaceCheckResult {
  const freeBytes = probe.getFreeBytes(input.dataDir);
  const totalBytes = probe.getTotalBytes(input.dataDir);
  const neededBytes = input.estimatedSnapshotBytes + input.estimatedWorkingSetBytes;
  const reserveBytes = resolveReserveBytes(totalBytes);

  const fits = neededBytes <= freeBytes;
  const remainingAfter = freeBytes - neededBytes;
  const withinReserve = fits && remainingAfter >= reserveBytes;
  const ok = fits && withinReserve;

  let reason: string | undefined;
  if (!fits) {
    reason =
      `need ${humanBytes(neededBytes)} free (snapshot + migration working set), have ${humanBytes(freeBytes)} — ` +
      `short by ${humanBytes(neededBytes - freeBytes)}. Set ${RESERVE_BYTES_ENV} to lower the required post-migration ` +
      `reserve on constrained deployments (this won't help here — the migration doesn't fit even before any reserve)`;
  } else if (!withinReserve) {
    reason =
      `need ${humanBytes(neededBytes)} free (snapshot + migration working set); have ${humanBytes(freeBytes)}, ` +
      `which covers it but would leave only ${humanBytes(remainingAfter)} free afterward — short of the ` +
      `${humanBytes(reserveBytes)} minimum reserve required post-migration. Set ${RESERVE_BYTES_ENV} to a lower ` +
      `byte count to shrink the required reserve on constrained deployments`;
  }

  return { ok, freeBytes, totalBytes, neededBytes, reserveBytes, reason };
}
