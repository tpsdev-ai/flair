/**
 * REM live replay — atomic state rewind from a snapshot tarball.
 *
 * Slice-2 PR-4. Implements the "every cycle is reversible" property:
 *   `flair rem restore <date> --apply` actually rewinds Harper state to the
 *   snapshot, not just extracts the tarball for inspection.
 *
 * Approach: client-side. The CLI sequentially calls existing `/Memory` and
 * `/Soul` endpoints (DELETE current rows for the agent, PUT snapshot rows).
 * Soul DELETE/PUT must use `soulApiCall` (operator Basic / deliberate
 * internal). Snapshot souls carry `agentId`, so a bare `apiCall` signs as
 * that agent and the source gate 403s. Souls are PUT before memories, and
 * leftover MemoryCandidate rows for the agent are deleted first, so
 * restored identity is not refused as learned content.
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
import { encodeRecordId } from "../lib/record-id-path.js";
import { ApiHttpError, apiErrorRawBody } from "../lib/auth-resolve.js";
import { readFileSync, existsSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { extractSnapshot, createSnapshot } from "./snapshot.js";

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<any>;

/** How long a memory write refused with `503 memory_provider_timeout` waits before its single retry. */
const RESTORE_PROVIDER_RETRY_DELAY_MS = 1_000;

/**
 * The server's `error` code on an `ApiHttpError`, parsed from the response body
 * that error carries (`apiErrorRawBody`; the message is never read). Returns
 * undefined for a non-HTTP error, an error that carries no body, or a body
 * without a string `error` field.
 */
function apiErrorCode(err: unknown): string | undefined {
  const text = apiErrorRawBody(err);
  if (text === undefined) return undefined;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** A memory write refused with exactly 503 and `memory_provider_timeout`. */
function isProviderTimeoutRefusal(err: unknown): boolean {
  return err instanceof ApiHttpError && err.status === 503 && apiErrorCode(err) === "memory_provider_timeout";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ops-API `search_by_conditions` helper (admin-authed). Harper's REST layer
 * maps `POST /<table>` to `resource.post()` and has no URL-suffix routing, so
 * candidate rows must be listed through the ops port with an
 * `{operation:"search_by_conditions"}` body. The CLI injects this when admin
 * credentials are available; when absent, candidate listing is best-effort
 * empty (mirrors runner.ts).
 */
export type OpsSearch = (table: string, conditions: any[], getAttributes: string[]) => Promise<any[]>;

export interface RestoreOpts {
  agentId: string;
  snapshotPath: string;
  flairVersion: string;
  apiCall: ApiCall;
  /**
   * Ops-API `search_by_conditions` helper (admin-authed). Injected by the CLI;
   * candidates live on the ops port, which the agent-signed `apiCall` cannot
   * reach. When absent, `listAgentCandidates` returns no rows.
   */
  opsSearch?: OpsSearch;
  /**
   * Operator/internal caller for Soul DELETE/PUT. Required in production:
   * `apiCall` extracts `agentId` from snapshot rows and signs as that agent.
   * Tests may omit it and reuse `apiCall`.
   */
  soulApiCall?: ApiCall;
  /** Override snapshot root used for the pre-restore snapshot. */
  preRestoreSnapshotRoot?: string;
  /** When true, plan and report what would happen — no API mutations. */
  dryRun?: boolean;
  /**
   * After the PUT loop, GET back the agent's memories + souls and compare
   * their ids with the snapshot's: snapshot ids that are missing and ids the
   * snapshot does not hold are reported. Row content is not compared. Default
   * true. Disable only for tests that intentionally simulate inconsistent state.
   */
  verifyPostRestore?: boolean;
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
    candidates: number;
  };
  restored: {
    memories: number;
    souls: number;
  };
  /**
   * Memory ids whose write was refused with `503 memory_provider_timeout` and
   * retried once. A row is listed here whether the retry succeeded or failed.
   */
  retried: {
    memories: string[];
  };
  /**
   * Post-restore state verification. Populated when verifyPostRestore is on
   * (default). `missing*` IDs were in the snapshot but absent from Harper
   * afterwards. `extra*` IDs were present afterwards but not in the snapshot.
   * Both fields being empty means the agent's memory and soul ids match the
   * snapshot's; row content is not compared.
   */
  verified?: {
    expectedMemoryIds: string[];
    expectedSoulIds: string[];
    actualMemoryIds: string[];
    actualSoulIds: string[];
    missingMemoryIds: string[];
    missingSoulIds: string[];
    extraMemoryIds: string[];
    extraSoulIds: string[];
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

function soulWrite(opts: RestoreOpts): ApiCall {
  return opts.soulApiCall ?? opts.apiCall;
}

async function listAgentCandidates(opsSearch: OpsSearch | undefined, agentId: string): Promise<any[]> {
  if (!opsSearch) return [];
  return asArray(await opsSearch("MemoryCandidate", [
    { search_attribute: "agentId", search_type: "equals", search_value: agentId },
  ], ["id", "claim"]));
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
 *   5. Fetch + delete current memories/souls/candidates for the agent (skip in dry-run).
 *   6. PUT snapshot souls, then memories (skip in dry-run).
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
    deleted: { memories: 0, souls: 0, candidates: 0 },
    restored: { memories: 0, souls: 0 },
    retried: { memories: [] },
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

  // 3. Verify agent id matches. Hard-fail on missing OR mismatched —
  //    the previous `metadata.agentId && ...` short-circuited on missing,
  //    which means a snapshot crafted without metadata.agentId would bypass
  //    the cross-agent guard entirely. v0.9.0+ snapshots always write
  //    metadata.agentId (see src/rem/snapshot.ts), so the missing case can
  //    only originate from pre-v0.9.0 snapshots or external/hand-edited
  //    input — both of which we must reject.
  if (!metadata.agentId) {
    errors.push(
      `snapshot is missing metadata.agentId — refusing to restore (pre-v0.9.0 or untrusted snapshot)`,
    );
    result.status = "failed";
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }
  if (metadata.agentId !== opts.agentId) {
    errors.push(
      `snapshot agentId (${metadata.agentId}) does not match target (${opts.agentId}) — refusing to restore cross-agent`,
    );
    result.status = "failed";
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  if (opts.dryRun) {
    // In dry-run, report planned counts. Still fetch current state for
    // accurate deleted-counts reporting, including leftover candidates
    // that --apply will wipe before Soul PUT.
    try {
      const currentMem = asArray(await opts.apiCall("GET", `/Memory?agentId=${encodeURIComponent(opts.agentId)}`));
      const currentSouls = asArray(await opts.apiCall("GET", `/Soul?agentId=${encodeURIComponent(opts.agentId)}`));
      const currentCandidates = await listAgentCandidates(opts.opsSearch, opts.agentId);
      result.deleted.memories = currentMem.length;
      result.deleted.souls = currentSouls.length;
      result.deleted.candidates = currentCandidates.length;
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
      pendingCandidateCount: null, // not counted at restore time (flair#2680)
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

  // 5. Delete current memories, souls, and leftover candidates. Candidates
  // are not in the snapshot, but refuseLearnedSoulWrite matches claim text,
  // so a leftover row 403s Soul PUT after operator auth succeeds. A failed
  // candidate listing stops the restore before any delete.
  let currentCandidates: any[] = [];
  try {
    currentCandidates = await listAgentCandidates(opts.opsSearch, opts.agentId);
  } catch (err: any) {
    errors.push(`fetch-candidates: ${err?.message ?? String(err)}`);
    result.status = "failed";
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }
  for (const m of currentMem) {
    if (!m?.id) continue;
    try {
      await opts.apiCall("DELETE", `/Memory/${encodeRecordId(String(m.id))}`);
      result.deleted.memories++;
    } catch (err: any) {
      errors.push(`delete-memory ${m.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const s of currentSouls) {
    if (!s?.id) continue;
    try {
      await soulWrite(opts)("DELETE", `/Soul/${encodeRecordId(String(s.id))}`);
      result.deleted.souls++;
    } catch (err: any) {
      errors.push(`delete-soul ${s.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const c of currentCandidates) {
    if (!c?.id) continue;
    try {
      await opts.apiCall("DELETE", `/MemoryCandidate/${encodeRecordId(String(c.id))}`);
      result.deleted.candidates++;
    } catch (err: any) {
      errors.push(`delete-candidate ${c.id}: ${err?.message ?? String(err)}`);
    }
  }

  // 6. PUT snapshot rows. Souls first: refuseLearnedSoulWrite matches the
  // target agent's Memory text, so memories-then-souls 403s a previously
  // valid snapshot even with operator credentials.
  for (const s of souls) {
    if (!s?.id) continue;
    try {
      await soulWrite(opts)("PUT", `/Soul/${encodeRecordId(String(s.id))}`, s);
      result.restored.souls++;
    } catch (err: any) {
      errors.push(`put-soul ${s.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const m of memories) {
    if (!m?.id) continue;
    const id = String(m.id);
    try {
      try {
        await opts.apiCall("PUT", `/Memory/${encodeRecordId(id)}`, m);
      } catch (err: any) {
        // The write-lock contract states a provider-bound refusal wrote
        // nothing, so replaying this one PUT cannot double-write the row.
        if (!isProviderTimeoutRefusal(err)) throw err;
        result.retried.memories.push(id);
        await delay(RESTORE_PROVIDER_RETRY_DELAY_MS);
        // No client-side timeout: a request abandoned at a client deadline
        // could still commit after this row was recorded failed.
        await opts.apiCall("PUT", `/Memory/${encodeRecordId(id)}`, m);
      }
      result.restored.memories++;
    } catch (err: any) {
      errors.push(`put-memory ${id}: ${err?.message ?? String(err)}`);
    }
  }

  // 7. Verify post-restore state (default on; opt-out via verifyPostRestore=false).
  //    Compares ids only: it reports snapshot ids missing from the agent's
  //    rows and ids present that the snapshot does not hold; row content is
  //    not compared. Per-ID diff, not just counts — count parity can hide
  //    simultaneous PUT+DELETE failures that wash out numerically.
  if (opts.verifyPostRestore !== false) {
    try {
      const verifyMem = asArray(await opts.apiCall("GET", `/Memory?agentId=${encodeURIComponent(opts.agentId)}`));
      const verifySouls = asArray(await opts.apiCall("GET", `/Soul?agentId=${encodeURIComponent(opts.agentId)}`));

      const expectedMemoryIds = memories.filter((m) => m?.id).map((m) => String(m.id));
      const expectedSoulIds = souls.filter((s) => s?.id).map((s) => String(s.id));
      const actualMemoryIds = verifyMem.filter((m) => m?.id).map((m) => String(m.id));
      const actualSoulIds = verifySouls.filter((s) => s?.id).map((s) => String(s.id));

      const expMem = new Set(expectedMemoryIds);
      const expSoul = new Set(expectedSoulIds);
      const actMem = new Set(actualMemoryIds);
      const actSoul = new Set(actualSoulIds);

      const missingMemoryIds = [...expMem].filter((id) => !actMem.has(id));
      const missingSoulIds = [...expSoul].filter((id) => !actSoul.has(id));
      const extraMemoryIds = [...actMem].filter((id) => !expMem.has(id));
      const extraSoulIds = [...actSoul].filter((id) => !expSoul.has(id));

      result.verified = {
        expectedMemoryIds,
        expectedSoulIds,
        actualMemoryIds,
        actualSoulIds,
        missingMemoryIds,
        missingSoulIds,
        extraMemoryIds,
        extraSoulIds,
      };

      if (missingMemoryIds.length > 0) {
        errors.push(`post-restore-verify: ${missingMemoryIds.length} memory rows missing (e.g. ${missingMemoryIds.slice(0, 3).join(", ")})`);
      }
      if (missingSoulIds.length > 0) {
        errors.push(`post-restore-verify: ${missingSoulIds.length} soul rows missing (e.g. ${missingSoulIds.slice(0, 3).join(", ")})`);
      }
      if (extraMemoryIds.length > 0) {
        errors.push(`post-restore-verify: ${extraMemoryIds.length} unexpected memory rows present (e.g. ${extraMemoryIds.slice(0, 3).join(", ")})`);
      }
      if (extraSoulIds.length > 0) {
        errors.push(`post-restore-verify: ${extraSoulIds.length} unexpected soul rows present (e.g. ${extraSoulIds.slice(0, 3).join(", ")})`);
      }
    } catch (err: any) {
      errors.push(`post-restore-verify: ${err?.message ?? String(err)}`);
    }
  }

  rmSync(tmp, { recursive: true, force: true });

  if (errors.length > 0) {
    result.status = "failed";
  }
  return result;
}
