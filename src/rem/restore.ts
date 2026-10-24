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
import { ApiHttpError, ApiRequestOutcomeUnknown, apiErrorRawBody } from "../lib/auth-resolve.js";
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
 * One line about an unknown-outcome id, from the post-restore read. Present
 * does NOT mean restored: comparing ids alone cannot tell a row this restore
 * wrote from a pre-existing row that already had the id.
 */
export function formatUnknownState(state: { entity: "memory" | "soul"; id: string; present: boolean }): string {
  return state.present
    ? `${state.entity} ${state.id}: present on the target after restore; an id-only check cannot tell whether this restore wrote the row or it was already present, so its state is unverified`
    : `${state.entity} ${state.id}: absent from the target after restore; the deadline fired before a complete response, so whether the write landed is unresolved and its state is unverified`;
}

/** The server release that first serves `GET /AdminMemoryCandidates/{agentId}`. */
export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.63.0";

/** The page size restore asks the admin-only candidate route for. */
export const CANDIDATE_LIST_LIMIT = 500;

/** The most candidate-listing pages one restore requests before it refuses. */
export const CANDIDATE_LIST_MAX_PAGES = 2_000;

export interface RestoreOpts {
  agentId: string;
  snapshotPath: string;
  flairVersion: string;
  apiCall: ApiCall;
  /**
   * When false, the dry run does not list leftover candidates. The CLI sets
   * this only for a dry run without a resolved admin password. A live restore
   * always lists (the CLI requires the admin password); one given `false` is
   * refused before any request.
   */
  listCandidates?: boolean;
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
   * snapshot does not hold are reported. It checks Memory and Soul ids, not
   * candidates: candidate rows are not read back. Row content is not compared.
   * Default true. Disable only for tests that intentionally simulate
   * inconsistent state.
   */
  verifyPostRestore?: boolean;
  /** Override tmpdir for testing. */
  tmpRootOverride?: string;
  /** Override "now" for testing. */
  nowOverride?: Date;
}

export interface RestoreResult {
  /**
   * `unresolved` means at least one write's outcome is unknown (see `unknown`);
   * it is never reported as `completed`, and `errors` entries do not turn it
   * into `failed`.
   */
  status: "completed" | "dry-run" | "unresolved" | "failed";
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
   * Ids whose PUT or DELETE ended at the whole-request deadline without a
   * complete response, so whether it took effect is unknown. They are not in
   * `errors` and are not counted restored or deleted; none is retried. Once
   * any write to a table and record id has an unknown outcome, no later write
   * to that same table and record id in this run is sent — a late write could
   * change or remove the row — and the skipped snapshot id is listed in
   * `skippedAfterUnknownDelete`. Any entry here makes `status` `unresolved`.
   * Verification reports what an id-only read can tell about each memory and
   * soul id here.
   */
  unknown: {
    memories: string[];
    souls: string[];
    candidates: string[];
  };
  /**
   * Snapshot ids not written because an earlier write (DELETE or PUT) to the
   * same table and record id had an unknown outcome (they are also in
   * `unknown`). Listed only when the run reached their write. The field name
   * predates the rule covering PUTs as well as DELETEs.
   */
  skippedAfterUnknownDelete: {
    memories: string[];
    souls: string[];
  };
  /**
   * Post-restore state verification. Populated when verifyPostRestore is on
   * (default). It compares Memory and Soul ids only, not candidates: candidate
   * rows are not read back. `missing*` IDs were in the snapshot but absent from Harper
   * afterwards, excluding ids whose write outcome is unknown (those are
   * reported in `unknownStates`). `extra*` IDs were present afterwards but not in the snapshot.
   * Both fields being empty means every id whose write outcome is known matches
   * the snapshot's; ids with an unknown write outcome are reported in
   * `unknownStates` instead. Row content is not compared.
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
    /**
     * For each memory and soul id in `unknown`, whether the post-restore read
     * shows it present. Present does not mean restored: an id-only check cannot
     * tell a row this restore wrote from a pre-existing row with the same id.
     */
    unknownStates: Array<{ entity: "memory" | "soul"; id: string; present: boolean }>;
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

function isCandidateRoute404(err: unknown): boolean {
  return err instanceof ApiHttpError && err.status === 404;
}

/** The refusal for a candidate listing restore could not read completely. */
function incompleteListing(agentId: string, state: string, remedy = ""): Error {
  return new Error(
    `the target's MemoryCandidate listing for agent ${agentId} could not be read completely: ${state}. `
      + `No target rows were deleted or written.${remedy ? ` ${remedy}` : ""}`,
  );
}

/**
 * One agent's leftover candidates, read through the `apiCall` restore uses
 * for its Memory reads, deletes and writes, its Soul reads and its
 * MemoryCandidate deletes. Soul deletes and writes use `soulApiCall` when one
 * is given; the CLI binds both calls to the same target. Each candidate object
 * carries only an id; each reply also carries `hasMore`.
 *
 * Pages through the route with `after` set to the last id of the page before,
 * until a page answers `hasMore: false`, and returns only that complete
 * listing. A `hasMore: true` page with no candidates (the cursor cannot move),
 * an id listed twice, or more than {@link CANDIDATE_LIST_MAX_PAGES} pages is
 * refused.
 */
async function listAgentCandidates(apiCall: ApiCall, agentId: string): Promise<Array<{ id: string }>> {
  const listed: Array<{ id: string }> = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 1; page <= CANDIDATE_LIST_MAX_PAGES; page++) {
    const query = `?limit=${CANDIDATE_LIST_LIMIT}${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`;
    let body: any;
    try {
      body = await apiCall("GET", `/AdminMemoryCandidates/${encodeURIComponent(agentId)}${query}`);
    } catch (err) {
      // Only this GET's 404 gets the candidate-route 404 guidance.
      if (isCandidateRoute404(err)) throw new Error(candidateRoute404Guidance(err as ApiHttpError));
      if (err instanceof ApiHttpError && apiErrorCode(err) === "candidate_id_unusable") {
        throw incompleteListing(
          agentId,
          "GET /AdminMemoryCandidates answered candidate_id_unusable (a row has no usable id)",
          "Remove or repair that agent's MemoryCandidate row without a usable id on the target, then retry.",
        );
      }
      throw incompleteListing(agentId, `GET /AdminMemoryCandidates failed: ${(err as any)?.message ?? String(err)}`);
    }
    const defect = candidateListDefect(body);
    if (defect) {
      throw incompleteListing(agentId, `GET /AdminMemoryCandidates returned an unexpected response shape: ${defect}`);
    }
    for (const entry of body.candidates as Array<{ id: string }>) {
      if (seen.has(entry.id)) {
        throw incompleteListing(agentId, `GET /AdminMemoryCandidates listed candidate id ${entry.id} twice (candidate_id_repeated)`);
      }
      seen.add(entry.id);
      listed.push({ id: entry.id });
    }
    if (body.hasMore === false) return listed;
    // A page that repeats the cursor's own id is refused above as a repeated id.
    const last: string | undefined = body.candidates.at(-1)?.id;
    if (last === undefined) {
      throw incompleteListing(
        agentId,
        `page ${page} of GET /AdminMemoryCandidates answered hasMore: true with no candidates, so the cursor cannot move past ${after === undefined ? "the start" : after} (candidate_cursor_not_advancing)`,
      );
    }
    after = last;
  }
  throw incompleteListing(
    agentId,
    `GET /AdminMemoryCandidates still answered hasMore: true after ${CANDIDATE_LIST_MAX_PAGES} pages of ${CANDIDATE_LIST_LIMIT}, the most restore requests (candidate_listing_page_limit)`,
  );
}

/** The first required field a candidate-route body lacks or mistypes, or null when `candidates` and `hasMore` check out. */
function candidateListDefect(body: any): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "the body is not an object";
  if (!Array.isArray(body.candidates)) return "candidates is not an array";
  for (const [i, entry] of body.candidates.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `candidates[${i}] is not an object`;
    if (typeof entry.id !== "string" || entry.id.length === 0) return `candidates[${i}].id is not a non-empty string`;
  }
  if (typeof body.hasMore !== "boolean") return "hasMore is missing or not a boolean";
  return null;
}

/** The candidate-route 404 guidance: the operator message when GET /AdminMemoryCandidates answers 404. */
function candidateRoute404Guidance(err: ApiHttpError): string {
  return `restore lists leftover MemoryCandidate rows through GET /AdminMemoryCandidates on the restore target, and the target answered HTTP ${err.status}. `
    + `That route is part of Flair server ${CANDIDATE_LIST_MIN_SERVER_VERSION}; if the target runs an older server, upgrade it to ${CANDIDATE_LIST_MIN_SERVER_VERSION} or newer, then retry. `
    + "No target rows were deleted or written.";
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
 * the pre-restore snapshot path included so the operator can roll back. If any
 * write's outcome is unknown, the status is `unresolved` instead.
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
    unknown: { memories: [], souls: [], candidates: [] },
    skippedAfterUnknownDelete: { memories: [], souls: [] },
    errors,
  };

  if (!opts.dryRun && opts.listCandidates === false) {
    errors.push(
      "listCandidates: false is accepted only with dryRun: a live restore lists leftover MemoryCandidate rows before any delete. "
        + "No request was sent to the target.",
    );
    result.status = "failed";
    return result;
  }

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
      const currentCandidates = opts.listCandidates === false
        ? []
        : await listAgentCandidates(opts.apiCall, opts.agentId);
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
  let currentCandidates: Array<{ id: string }>;
  try {
    currentCandidates = await listAgentCandidates(opts.apiCall, opts.agentId);
  } catch (err: any) {
    errors.push(`fetch-candidates: ${err?.message ?? String(err)}`);
    result.status = "failed";
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }
  // Ids whose write outcome is unknown, per table. Once a table and record id
  // appears here, no later write to that same table and record id in this run
  // is sent: a late write could land after the restored row.
  const unknownMemoryWrites = new Set<string>();
  const unknownSoulWrites = new Set<string>();
  const unknownCandidateWrites = new Set<string>();
  for (const m of currentMem) {
    if (!m?.id) continue;
    const id = String(m.id);
    if (unknownMemoryWrites.has(id)) continue;
    try {
      await opts.apiCall("DELETE", `/Memory/${encodeRecordId(id)}`);
      result.deleted.memories++;
    } catch (err: any) {
      if (err instanceof ApiRequestOutcomeUnknown) {
        result.unknown.memories.push(id);
        unknownMemoryWrites.add(id);
        continue;
      }
      errors.push(`delete-memory ${m.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const s of currentSouls) {
    if (!s?.id) continue;
    const id = String(s.id);
    if (unknownSoulWrites.has(id)) continue;
    try {
      await soulWrite(opts)("DELETE", `/Soul/${encodeRecordId(id)}`);
      result.deleted.souls++;
    } catch (err: any) {
      if (err instanceof ApiRequestOutcomeUnknown) {
        result.unknown.souls.push(id);
        unknownSoulWrites.add(id);
        continue;
      }
      errors.push(`delete-soul ${s.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const c of currentCandidates) {
    if (!c?.id) continue;
    const id = String(c.id);
    if (unknownCandidateWrites.has(id)) continue;
    try {
      await opts.apiCall("DELETE", `/MemoryCandidate/${encodeRecordId(id)}`);
      result.deleted.candidates++;
    } catch (err: any) {
      if (err instanceof ApiRequestOutcomeUnknown) {
        result.unknown.candidates.push(id);
        unknownCandidateWrites.add(id);
        continue;
      }
      errors.push(`delete-candidate ${c.id}: ${err?.message ?? String(err)}`);
    }
  }

  // 6. PUT snapshot rows. Souls first: refuseLearnedSoulWrite matches the
  // target agent's Memory text, so memories-then-souls 403s a previously
  // valid snapshot even with operator credentials.
  for (const s of souls) {
    if (!s?.id) continue;
    const id = String(s.id);
    if (unknownSoulWrites.has(id)) {
      result.skippedAfterUnknownDelete.souls.push(id);
      continue;
    }
    try {
      await soulWrite(opts)("PUT", `/Soul/${encodeRecordId(id)}`, s);
      result.restored.souls++;
    } catch (err: any) {
      if (err instanceof ApiRequestOutcomeUnknown) {
        result.unknown.souls.push(id);
        unknownSoulWrites.add(id);
        continue;
      }
      errors.push(`put-soul ${s.id}: ${err?.message ?? String(err)}`);
    }
  }
  for (const m of memories) {
    if (!m?.id) continue;
    const id = String(m.id);
    if (unknownMemoryWrites.has(id)) {
      result.skippedAfterUnknownDelete.memories.push(id);
      continue;
    }
    try {
      try {
        await opts.apiCall("PUT", `/Memory/${encodeRecordId(id)}`, m);
      } catch (err: any) {
        // A write whose outcome is unknown may have committed, so it is
        // recorded as unknown by the outer catch and never replayed.
        if (err instanceof ApiRequestOutcomeUnknown) throw err;
        // The write-lock contract states a provider-bound refusal wrote
        // nothing, so replaying this one PUT cannot double-write the row.
        if (!isProviderTimeoutRefusal(err)) throw err;
        result.retried.memories.push(id);
        await delay(RESTORE_PROVIDER_RETRY_DELAY_MS);
        // No client-side timer here: a request abandoned at a client deadline
        // could still commit after this row was recorded failed. The whole
        // request now carries the shared deadline, and its expiry is an
        // ApiRequestOutcomeUnknown recorded as unknown by the outer catch.
        await opts.apiCall("PUT", `/Memory/${encodeRecordId(id)}`, m);
      }
      result.restored.memories++;
    } catch (err: any) {
      if (err instanceof ApiRequestOutcomeUnknown) {
        result.unknown.memories.push(id);
        unknownMemoryWrites.add(id);
        continue;
      }
      errors.push(`put-memory ${id}: ${err?.message ?? String(err)}`);
    }
  }

  // 7. Verify post-restore state (default on; opt-out via verifyPostRestore=false).
  //    Compares Memory and Soul ids only; candidates are not read back. It
  //    reports snapshot ids missing from the agent's rows and ids present that
  //    the snapshot does not hold; row content is not compared. Per-ID diff,
  //    not just counts — count parity can hide simultaneous PUT+DELETE failures
  //    that wash out numerically.
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

      const missingMemoryIds = [...expMem].filter((id) => !actMem.has(id) && !result.unknown.memories.includes(id));
      const missingSoulIds = [...expSoul].filter((id) => !actSoul.has(id) && !result.unknown.souls.includes(id));
      const extraMemoryIds = [...actMem].filter((id) => !expMem.has(id));
      const extraSoulIds = [...actSoul].filter((id) => !expSoul.has(id));

      const unknownStates: Array<{ entity: "memory" | "soul"; id: string; present: boolean }> = [
        ...result.unknown.memories.map((id) => ({ entity: "memory" as const, id, present: actMem.has(id) })),
        ...result.unknown.souls.map((id) => ({ entity: "soul" as const, id, present: actSoul.has(id) })),
      ];

      result.verified = {
        expectedMemoryIds,
        expectedSoulIds,
        actualMemoryIds,
        actualSoulIds,
        missingMemoryIds,
        missingSoulIds,
        extraMemoryIds,
        extraSoulIds,
        unknownStates,
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
  if (result.unknown.memories.length > 0 || result.unknown.souls.length > 0 || result.unknown.candidates.length > 0) {
    result.status = "unresolved";
  }
  return result;
}
