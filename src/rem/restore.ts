/**
 * REM live replay — atomic state rewind from a snapshot tarball.
 *
 * Slice-2 PR-4. Implements the "every cycle is reversible" property:
 *   `flair rem restore <date> --apply` actually rewinds Harper state to the
 *   snapshot, not just extracts the tarball for inspection.
 *
 * Approach: client-side. The CLI sequentially calls existing `/Memory` and
 * `/Soul` endpoints (DELETE current rows for the agent, PUT snapshot rows).
 * No new server endpoint — keeps the auth surface unchanged and avoids the
 * Harper body-size limit on uploading large memory exports inline.
 *
 * Reversibility-of-restore guarantee: before any destructive op, this
 * module creates a pre-restore snapshot of the CURRENT state. If something
 * fails mid-flight, the operator can restore from the pre-restore snapshot
 * to roll back.
 *
 * Multi-agent restore (admin restoring another agent's state) is not in
 * scope here; the operator's agent can only restore its own memories.
 * Cross-agent restore is a 1.1+ feature.
 */
import { readFileSync, existsSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { extractSnapshot, createSnapshot } from "./snapshot.js";

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<any>;

export interface RestoreOpts {
  agentId: string;
  snapshotPath: string;
  flairVersion: string;
  apiCall: ApiCall;
  /** Override snapshot root used for the pre-restore snapshot. */
  preRestoreSnapshotRoot?: string;
  /** When true, plan and report what would happen — no API mutations. */
  dryRun?: boolean;
  /** Override tmpdir for testing. */
  tmpRootOverride?: string;
  /** Override "now" for testing. */
  nowOverride?: Date;
}

export interface RestoreResult {
  status: "completed" | "dry-run" | "failed";
  agentId: string;
  snapshotPath: string;
  /** Path to the pre-restore-state snapshot (preserved on real restore + failures). */
  preRestoreSnapshotPath?: string;
  deleted: {
    memories: number;
    souls: number;
  };
  restored: {
    memories: number;
    souls: number;
  };
  errors: string[];
}

function asArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.results)) return obj.results as any[];
    if (Array.isArray(obj.items)) return obj.items as any[];
  }
  return [];
}

function parseJsonlSafe(text: string): any[] {
  if (!text.trim()) return [];
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Applies a snapshot tarball to live Harper state for the given agent.
 *
 * Steps:
 *   1. Extract the snapshot to a tmpdir.
 *   2. Parse memories.jsonl + soul.json + metadata.json.
 *   3. Verify metadata.agentId matches opts.agentId (prevents accidental
 *      cross-agent restore — the file might have been hand-copied).
 *   4. Create a pre-restore snapshot of current state (skip in dry-run).
 *   5. Fetch + delete current memories/souls for the agent (skip in dry-run).
 *   6. PUT snapshot memories/souls back into Harper (skip in dry-run).
 *   7. Return counts.
 *
 * On any error after step 4: the result reports `status: "failed"` with
 * the pre-restore snapshot path included so the operator can roll back.
 */
export async function applySnapshot(opts: RestoreOpts): Promise<RestoreResult> {
  const errors: string[] = [];
  const result: RestoreResult = {
    status: "completed",
    agentId: opts.agentId,
    snapshotPath: opts.snapshotPath,
    deleted: { memories: 0, souls: 0 },
    restored: { memories: 0, souls: 0 },
    errors,
  };

  if (!existsSync(opts.snapshotPath)) {
    errors.push(`snapshot does not exist: ${opts.snapshotPath}`);
    result.status = "failed";
    return result;
  }

  // 1+2. Extract and parse. mkdtempSync creates an empty dir; extractSnapshot
  // refuses to extract into an existing dir, so we point it at a non-existing
  // subdir of the tmp scratch space.
  const tmpRoot = opts.tmpRootOverride ?? tmpdir();
  const tmp = mkdtempSync(resolve(tmpRoot, "flair-rem-restore-"));
  const extractTo = resolve(tmp, "snapshot");
  let memories: any[];
  let souls: any[];
  let metadata: Record<string, unknown>;

  try {
    await extractSnapshot({ snapshotPath: opts.snapshotPath, targetDir: extractTo });
    const memText = readFileSync(resolve(extractTo, "memories.jsonl"), "utf-8");
    memories = parseJsonlSafe(memText);
    const soulRaw = JSON.parse(readFileSync(resolve(extractTo, "soul.json"), "utf-8"));
    souls = Array.isArray(soulRaw)
      ? soulRaw
      : soulRaw && typeof soulRaw === "object"
        ? [soulRaw]
        : [];
    metadata = JSON.parse(readFileSync(resolve(extractTo, "metadata.json"), "utf-8"));
  } catch (err: any) {
    errors.push(`extract: ${err?.message ?? String(err)}`);
    result.status = "failed";
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  // 3. Verify agent id matches.
  if (metadata.agentId && metadata.agentId !== opts.agentId) {
    errors.push(
      `snapshot agentId (${metadata.agentId}) does not match target (${opts.agentId}) — refusing to restore cross-agent`,
    );
    result.status = "failed";
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  if (opts.dryRun) {
    // In dry-run, report planned counts. Still fetch current state for
    // accurate deleted-counts reporting.
    try {
      const currentMem = asArray(await opts.apiCall("GET", `/Memory?agentId=${encodeURIComponent(opts.agentId)}`));
      const currentSouls = asArray(await opts.apiCall("GET", `/Soul?agentId=${encodeURIComponent(opts.agentId)}`));
      result.deleted.memories = currentMem.length;
      result.deleted.souls = currentSouls.length;
      result.restored.memories = memories.length;
      result.restored.souls = souls.length;
      result.status = "dry-run";
    } catch (err: any) {
      errors.push(`fetch-current: ${err?.message ?? String(err)}`);
      result.status = "failed";
    }
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  // 4. Pre-restore snapshot of current state.
  let currentMem: any[];
  let currentSouls: any[];
  try {
    currentMem = asArray(await opts.apiCall("GET", `/Memory?agentId=${encodeURIComponent(opts.agentId)}`));
    currentSouls = asArray(await opts.apiCall("GET", `/Soul?agentId=${encodeURIComponent(opts.agentId)}`));

    const preRestore = await createSnapshot({
      agentId: opts.agentId,
      flairVersion: opts.flairVersion,
      memories: currentMem,
      soul: currentSouls.length === 1 ? currentSouls[0] : currentSouls.length > 1 ? currentSouls : null,
      pendingCandidateCount: 0, // not load-bearing at restore time
      rootOverride: opts.preRestoreSnapshotRoot,
      runId: `rem-restore-pre-${(opts.nowOverride ?? new Date()).toISOString().replace(/[:.]/g, "-")}`,
      nowOverride: opts.nowOverride,
    });
    result.preRestoreSnapshotPath = preRestore.path;
  } catch (err: any) {
    errors.push(`pre-restore-snapshot: ${err?.message ?? String(err)}`);
    result.status = "failed";
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  // 5. Delete current memories + souls (sequential to keep error semantics).
  for (const m of currentMem) {
    if (!m?.id) continue;
    try {
      await opts.apiCall("DELETE", `/Memory/${encodeURIComponent(String(m.id))}`);
      result.deleted.memories++;
    } catch (err: any) {
      errors.push(`delete-memory ${m.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const s of currentSouls) {
    if (!s?.id) continue;
    try {
      await opts.apiCall("DELETE", `/Soul/${encodeURIComponent(String(s.id))}`);
      result.deleted.souls++;
    } catch (err: any) {
      errors.push(`delete-soul ${s.id}: ${err?.message ?? String(err)}`);
    }
  }

  // 6. PUT snapshot rows.
  for (const m of memories) {
    if (!m?.id) continue;
    try {
      await opts.apiCall("PUT", `/Memory/${encodeURIComponent(String(m.id))}`, m);
      result.restored.memories++;
    } catch (err: any) {
      errors.push(`put-memory ${m.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const s of souls) {
    if (!s?.id) continue;
    try {
      await opts.apiCall("PUT", `/Soul/${encodeURIComponent(String(s.id))}`, s);
      result.restored.souls++;
    } catch (err: any) {
      errors.push(`put-soul ${s.id}: ${err?.message ?? String(err)}`);
    }
  }

  rmSync(tmp, { recursive: true, force: true });

  if (errors.length > 0) {
    result.status = "failed";
  }
  return result;
}
