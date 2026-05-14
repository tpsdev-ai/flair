/**
 * REM snapshot module — pre-cycle snapshot + listing + restore extraction.
 *
 * Per FLAIR-NIGHTLY-REM § 4 step 2 and § 9. Produces tar.gz archives at
 * ~/.flair/snapshots/<agentId>/<ISO-timestamp>.tar.gz containing:
 *   - memories.jsonl  — one Memory row per line
 *   - soul.json       — Soul row (or null)
 *   - metadata.json   — agent id, run id, flair version, counts
 *
 * Mirrors the `flair session snapshot` pattern (tar.gz, 600 perms, agent-
 * rooted under ~/.flair/snapshots/). Pure filesystem — the caller fetches
 * the data via the Harper HTTP API and passes it in.
 *
 * Used by:
 *   - `flair rem snapshot list`
 *   - `flair rem restore <date>`
 *   - The nightly runner (slice-1 follow-on)
 */
import { mkdirSync, writeFileSync, statSync, chmodSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { create as tarCreate, extract as tarExtract, list as tarList } from "tar";

export const SNAPSHOT_ROOT = resolve(homedir(), ".flair", "snapshots");

/** Validates the agent id and returns its snapshot directory. */
export function remSnapshotDir(agent: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {
    throw new Error(`invalid agent id: ${agent}`);
  }
  return resolve(SNAPSHOT_ROOT, agent);
}

export interface SnapshotMeta {
  agentId: string;
  runId: string;
  flairVersion: string;
  createdAt: string;
  memoryCount: number;
  pendingCandidateCount: number;
  soulPresent: boolean;
}

export interface CreateOpts {
  agentId: string;
  flairVersion: string;
  memories: Array<Record<string, unknown>>;
  soul: Record<string, unknown> | null;
  pendingCandidateCount: number;
  /** Override the run id (defaults to `rem-nightly-<iso-ts>`). */
  runId?: string;
  /** Override the snapshot root for testing. */
  rootOverride?: string;
  /** Override "now" for deterministic tests. */
  nowOverride?: Date;
}

export interface CreateResult {
  path: string;
  size: number;
  meta: SnapshotMeta;
}

/**
 * Creates a tar.gz snapshot at <root>/<agentId>/<ISO-timestamp>.tar.gz.
 * Returns the path, byte size, and metadata embedded in the archive.
 *
 * Tarball perms: 0600 (owner-only).
 */
export async function createSnapshot(opts: CreateOpts): Promise<CreateResult> {
  const now = opts.nowOverride ?? new Date();
  const isoFull = now.toISOString().replace(/[:.]/g, "-");

  const root = opts.rootOverride ?? SNAPSHOT_ROOT;
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.agentId)) {
    throw new Error(`invalid agent id: ${opts.agentId}`);
  }
  const dir = resolve(root, opts.agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tarballName = `${isoFull}.tar.gz`;
  const tarballPath = resolve(dir, tarballName);

  const meta: SnapshotMeta = {
    agentId: opts.agentId,
    runId: opts.runId ?? `rem-nightly-${isoFull}`,
    flairVersion: opts.flairVersion,
    createdAt: now.toISOString(),
    memoryCount: opts.memories.length,
    pendingCandidateCount: opts.pendingCandidateCount,
    soulPresent: opts.soul !== null,
  };

  const tmpDir = resolve(dir, `.tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  try {
    const memoryLines = opts.memories.map((m) => JSON.stringify(m)).join("\n");
    writeFileSync(
      resolve(tmpDir, "memories.jsonl"),
      memoryLines + (memoryLines.length ? "\n" : ""),
      { mode: 0o600 },
    );
    writeFileSync(
      resolve(tmpDir, "soul.json"),
      JSON.stringify(opts.soul, null, 2) + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      resolve(tmpDir, "metadata.json"),
      JSON.stringify(meta, null, 2) + "\n",
      { mode: 0o600 },
    );

    await tarCreate(
      { gzip: true, cwd: tmpDir, file: tarballPath, portable: true },
      ["memories.jsonl", "soul.json", "metadata.json"],
    );
    chmodSync(tarballPath, 0o600);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return { path: tarballPath, size: statSync(tarballPath).size, meta };
}

export interface SnapshotRow {
  agent: string;
  file: string;
  path: string;
  size: number;
  mtime: string;
}

/**
 * Lists snapshots at <root>/<agent>/*.tar.gz. Returns rows sorted by mtime
 * descending. Pass an agent filter to restrict to a single agent.
 */
export function listSnapshots(agentFilter?: string, rootOverride?: string): SnapshotRow[] {
  const root = rootOverride ?? SNAPSHOT_ROOT;
  if (!existsSync(root)) return [];

  let agents: string[];
  if (agentFilter) {
    if (!/^[a-zA-Z0-9_-]+$/.test(agentFilter)) {
      throw new Error(`invalid agent id: ${agentFilter}`);
    }
    agents = [agentFilter];
  } else {
    agents = readdirSync(root).filter((d) => {
      try {
        return statSync(resolve(root, d)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  const rows: SnapshotRow[] = [];
  for (const a of agents) {
    const dir = resolve(root, a);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".tar.gz")) continue;
      const p = resolve(dir, f);
      const s = statSync(p);
      rows.push({ agent: a, file: f, path: p, size: s.size, mtime: s.mtime.toISOString() });
    }
  }
  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return rows;
}

export interface ExtractOpts {
  snapshotPath: string;
  /** Defaults to `<snapshotPath>.restored` next to the tarball. */
  targetDir?: string;
  dryRun?: boolean;
}

export interface ExtractEntry {
  path: string;
  size: number;
}

export interface ExtractResult {
  /** Set only when dryRun is false. */
  targetDir?: string;
  entries: ExtractEntry[];
}

/**
 * Extracts a snapshot tar.gz into a target directory. Refuses to extract
 * over an existing directory — operator must pass a clean target.
 *
 * In dry-run mode, returns the tarball entry list without writing anything.
 */
export async function extractSnapshot(opts: ExtractOpts): Promise<ExtractResult> {
  if (!existsSync(opts.snapshotPath)) {
    throw new Error(`snapshot does not exist: ${opts.snapshotPath}`);
  }

  const entries: ExtractEntry[] = [];
  await tarList({
    file: opts.snapshotPath,
    onReadEntry: (e: any) => entries.push({ path: e.path, size: e.size ?? 0 }),
  });

  if (opts.dryRun) {
    return { entries };
  }

  const targetDir = opts.targetDir ?? `${opts.snapshotPath}.restored`;
  if (existsSync(targetDir)) {
    throw new Error(`target directory already exists: ${targetDir}`);
  }
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  await tarExtract({ file: opts.snapshotPath, cwd: targetDir });

  return { targetDir, entries };
}
