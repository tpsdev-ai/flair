/**
 * Continuity core (flair#1257 slice 2) — the shared logic behind the Claude
 * Code continuity hook adapter: the ephemeral session journal (write side,
 * `flair-continuity-capture`) and the agent-pull resume path grown into
 * `flair-session-start`.
 *
 * Design record: flair#1257 ("FINAL design (K&S ruled)" + the merged slice-2
 * acceptance scenarios + Sherlock's capture-content rulings). The shape in one
 * paragraph: continuity is the EXISTING `ephemeral` Memory tier (24h TTL,
 * private-only — the #1261 server guard refuses ephemeral+shared), auto-written
 * by harness hooks (PostToolUse/Stop), and resumed by agent-pull: SessionStart
 * emits at most ONE hint line ("N entries from your previous session…"), never
 * journal content. Promotion to durable memory is REM distillation's job
 * (#1205, slice 3) — nothing here summarizes or promotes.
 *
 * CAPTURE DISCIPLINE (Sherlock-ruled, binding — do not drift)
 * -----------------------------------------------------------
 * - PostToolUse journals ONLY the mutating-tool allowlist (MUTATING_TOOLS
 *   below). Read-only tools journal nothing — their results are
 *   world-recoverable, and journaling them would copy tool payloads into a
 *   store with cross-session readback.
 * - Bash: journal the `description` field ONLY — NEVER the command string.
 *   Argv is exactly where secrets ride; a journal that copies command lines
 *   re-creates the transcript-leak class. No description ⇒ the literal
 *   "bash: (no description)", never a fallback to the command.
 * - Write/Edit/NotebookEdit: file path only — never content, never diffs.
 * - Stop: a dedicated summary/intent field from the hook payload when present,
 *   else the final assistant text — either way HARD-bounded (see
 *   CAPTURE_BOUND_CHARS). Empty text ⇒ no journal (never a placeholder, never
 *   a synthesis from tool results).
 * - One row max per hook fire. Never the raw hook JSON. Never tool_response.
 *   No secret-scrubbing attempts — the bound plus the already-user-visible
 *   property of assistant prose IS the control; pattern-matching secrets is a
 *   losing game and would only add false confidence.
 *
 * ROW SHAPE (per the merged acceptance set)
 * -----------------------------------------
 *   durability: "ephemeral", visibility: "private" (EXPLICIT — defense in
 *   depth above the #1261 guard, never the durability-keyed default),
 *   tags: ["adk:continuity:<sessionId>"], sessionId, and
 *   meta: { seq, processUUID, sessionId, hook, tool? } — seq is a monotonic
 *   per-process counter (ordering insurance over createdAt alone), processUUID
 *   disambiguates concurrent processes sharing one agent identity.
 *
 * LOCAL FILES (never journal content — IDs and counters only)
 * -----------------------------------------------------------
 * - Pointer file  <dir>/<agentId>.current            (0600, dir 0700)
 *     { sessionId, processUUID, updatedAt } — the last-known session for this
 *     agent identity; the resume fast path. Rotated by SessionStart.
 * - State file    <dir>/<agentId>.<harnessSessionId>.state.json (0600)
 *     { sessionId, processUUID, seq, … } — seeded by SessionStart, read and
 *     seq-incremented (atomically, tmp+rename) by every capture fire. Keyed by
 *     the HARNESS session id so concurrent processes never share a state file
 *     (scenario S8) and compaction — same harness session id — finds the same
 *     file untouched (scenario S7: compaction ≠ restart; no rotation, no new
 *     sessionId).
 *
 * FAIL-OPEN THROUGHOUT: continuity is a recovery aid, not a correctness gate.
 * Flair unreachable, a #1261 guard 400, a malformed payload, a missing state
 * file — every failure degrades to "journal nothing / hint nothing" and never
 * blocks the agent's turn or boot.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── constants ───────────────────────────────────────────────────────────────

/** Tag prefix for journal rows — `adk:continuity:<sessionId>`. One tag, which
 *  is exactly the shape #1205's REM `scope:"tagged"` distillation consumes. */
export const CONTINUITY_TAG_PREFIX = "adk:continuity:";

/**
 * THE capture bound, in characters — applied as a HARD truncate (with a
 * visible ellipsis) to EVERY journal content line, not just the Stop excerpt.
 * Sherlock ruled a single uniform bound ("a bound that varies by content type
 * is hard to audit — 400 chars, hard truncate, every time").
 *
 * This bound is LOAD-BEARING, not cosmetic: it is what keeps a Stop excerpt a
 * summary instead of a dump, and it is the control that makes the capture
 * class acceptable at all. Raising it — or "capturing the full final text" —
 * is a security REGRESSION, not an enhancement.
 */
export const CAPTURE_BOUND_CHARS = 400;

/**
 * The mutating-tool allowlist — a CLOSED set; anything not listed journals
 * nothing (fail-closed). Why each member is here and the notable exclusions:
 * Write/Edit/NotebookEdit mutate file/cell state (NotebookEdit is included
 * precisely because a cell edit is a state mutation, not a read); Bash can
 * mutate anything. Read/Grep/Glob/WebFetch/WebSearch and every other
 * read-only tool are EXCLUDED because their results are world-recoverable —
 * the agent can simply re-observe them, and journaling them would copy tool
 * payloads into the journal.
 */
export const MUTATING_TOOLS = ["Write", "Edit", "NotebookEdit", "Bash"] as const;
export type MutatingTool = (typeof MUTATING_TOOLS)[number];

/** Default resume-search page — older context is distillation's job (#1205). */
export const RESUME_SEARCH_LIMIT = 50;

/** Fallback (agentId-wide) search page — bounded superset of one session. */
export const FALLBACK_SEARCH_LIMIT = 200;

/** Journal-write timeout (ms): the hook must never make the agent wait on a
 *  slow Flair. Overridable via FLAIR_CONTINUITY_TIMEOUT_MS, clamped below. */
export const DEFAULT_CONTINUITY_TIMEOUT_MS = 2000;
const CONTINUITY_TIMEOUT_FLOOR_MS = 250;
const CONTINUITY_TIMEOUT_CEILING_MS = 10_000;

/** Identifier shape for everything interpolated into a session-dir FILENAME
 *  (agentId, harness session id). No `/`, no `\`, no whitespace — traversal
 *  is impossible by shape; length-capped so a hostile hook payload can't
 *  manufacture pathological filenames. */
const SAFE_FILE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeFileId(value: unknown): value is string {
  return typeof value === "string" && SAFE_FILE_ID_RE.test(value);
}

export function resolveContinuityTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FLAIR_CONTINUITY_TIMEOUT_MS;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= CONTINUITY_TIMEOUT_FLOOR_MS && parsed <= CONTINUITY_TIMEOUT_CEILING_MS
    ? parsed
    : DEFAULT_CONTINUITY_TIMEOUT_MS;
}

// ── session dir / pointer / state files ─────────────────────────────────────

/** Where pointer + state files live. FLAIR_SESSION_DIR overrides for tests
 *  (homeOverride discipline — no test ever touches the real ~/.flair). */
export function resolveSessionDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.FLAIR_SESSION_DIR;
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(homedir(), ".flair", "session");
}

export function pointerPath(sessionDir: string, agentId: string): string {
  return join(sessionDir, `${agentId}.current`);
}

export function statePath(sessionDir: string, agentId: string, harnessSessionId: string): string {
  return join(sessionDir, `${agentId}.${harnessSessionId}.state.json`);
}

export interface SessionPointer {
  sessionId: string;
  processUUID: string;
  updatedAt: string;
}

export interface SessionState {
  sessionId: string;
  processUUID: string;
  seq: number;
  agentId: string;
  harnessSessionId: string;
  updatedAt: string;
}

/** 0600/0700 — the files carry session identifiers (never journal content),
 *  but they are still per-agent working state; keep them owner-only. */
function writeFilePrivate(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
  // writeFileSync's mode only applies on CREATE — an existing file keeps its
  // old bits, so re-assert.
  chmodSync(path, 0o600);
}

function ensureSessionDir(sessionDir: string): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
}

/** Read + parse the pointer file. null on ANY problem (missing, unreadable,
 *  malformed, wrong shape) — a bad pointer degrades to the fallback search,
 *  never to an error. */
export function readPointer(sessionDir: string, agentId: string): SessionPointer | null {
  try {
    const raw = readFileSync(pointerPath(sessionDir, agentId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionPointer> | null;
    if (parsed && typeof parsed.sessionId === "string" && parsed.sessionId !== "") {
      return {
        sessionId: parsed.sessionId,
        processUUID: typeof parsed.processUUID === "string" ? parsed.processUUID : "",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Read + parse a state file. null on ANY problem — capture then journals
 *  nothing (continuity wasn't seeded for this harness session). */
export function readState(sessionDir: string, agentId: string, harnessSessionId: string): SessionState | null {
  try {
    const raw = readFileSync(statePath(sessionDir, agentId, harnessSessionId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionState> | null;
    if (
      parsed &&
      typeof parsed.sessionId === "string" && parsed.sessionId !== "" &&
      typeof parsed.processUUID === "string" && parsed.processUUID !== "" &&
      typeof parsed.seq === "number" && Number.isFinite(parsed.seq)
    ) {
      return {
        sessionId: parsed.sessionId,
        processUUID: parsed.processUUID,
        seq: parsed.seq,
        agentId: typeof parsed.agentId === "string" ? parsed.agentId : agentId,
        harnessSessionId: typeof parsed.harnessSessionId === "string" ? parsed.harnessSessionId : harnessSessionId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Mint a fresh sessionId + processUUID, seed the per-harness-session state
 * file (seq 0) and rotate the pointer file to the new session. Called by the
 * SessionStart hook on startup/resume/clear — NEVER on compaction (the caller
 * gates on `source`; compaction keeps the same harness session id, so the same
 * state file — and therefore the same sessionId — stays in place untouched,
 * which is what makes scenario S7 hold by construction).
 *
 * Throws on fs failure — the caller treats that as "continuity unavailable"
 * and proceeds (fail-open), it never propagates out of the hook.
 */
export function seedSession(sessionDir: string, agentId: string, harnessSessionId: string, now: Date = new Date()): SessionState {
  ensureSessionDir(sessionDir);
  const state: SessionState = {
    sessionId: `cs-${randomUUID()}`,
    processUUID: randomUUID(),
    seq: 0,
    agentId,
    harnessSessionId,
    updatedAt: now.toISOString(),
  };
  writeFilePrivate(statePath(sessionDir, agentId, harnessSessionId), JSON.stringify(state, null, 2) + "\n");
  const pointer: SessionPointer = { sessionId: state.sessionId, processUUID: state.processUUID, updatedAt: state.updatedAt };
  writeFilePrivate(pointerPath(sessionDir, agentId), JSON.stringify(pointer, null, 2) + "\n");
  return state;
}

/**
 * Atomically increment the state file's seq and return the NEW state (the one
 * whose seq this capture fire owns). Write-to-temp + rename so a concurrent
 * reader never sees a torn file. Returns null on any failure — the caller
 * journals nothing rather than journaling with a wrong/duplicate seq.
 *
 * The seq is consumed BEFORE the network write, so even a failed write burns
 * its seq — gaps are fine, non-monotonicity is not.
 */
export function bumpSeq(sessionDir: string, agentId: string, harnessSessionId: string, now: Date = new Date()): SessionState | null {
  const current = readState(sessionDir, agentId, harnessSessionId);
  if (!current) return null;
  const next: SessionState = { ...current, seq: current.seq + 1, updatedAt: now.toISOString() };
  const finalPath = statePath(sessionDir, agentId, harnessSessionId);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFilePrivate(tmpPath, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmpPath, finalPath);
    return next;
  } catch {
    return null;
  }
}

// ── capture planning (pure) ─────────────────────────────────────────────────

/** Subset of the Claude Code hook payload the capture bin reads. It extracts
 *  ONLY these fields — the raw hook JSON (tool_input.command, tool_response,
 *  transcript_path, …) is NEVER stored or forwarded. */
export interface CaptureHookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  /** Stop payloads: the final assistant message text, when the harness
   *  provides it. Assistant-chosen prose — already user-visible. */
  last_assistant_message?: unknown;
  /** A dedicated summary/intent field, when the harness provides one —
   *  preferred over raw final text (intent-class by construction). */
  summary?: unknown;
  [key: string]: unknown;
}

export interface CapturePlan {
  hook: "PostToolUse" | "Stop";
  tool?: MutatingTool;
  /** The full journal content line — already hard-bounded. */
  content: string;
}

/** HARD truncate at CAPTURE_BOUND_CHARS with a visible ellipsis, so a reader
 *  knows the excerpt is incomplete and never acts on a cut sentence as if it
 *  were whole. See CAPTURE_BOUND_CHARS — the bound is load-bearing. */
export function hardBound(text: string): string {
  if (text.length <= CAPTURE_BOUND_CHARS) return text;
  return `${text.slice(0, CAPTURE_BOUND_CHARS)}…`;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Pure capture decision: hook payload → at most one journal line, or null for
 * "journal nothing" (read-only tool, empty Stop text, unknown/missing fields).
 * This function IS the capture discipline — see the module doc; every branch
 * below maps to a Sherlock-ruled rule.
 */
export function planCapture(input: CaptureHookInput): CapturePlan | null {
  const hook = input.hook_event_name;

  if (hook === "PostToolUse") {
    const tool = input.tool_name;
    // Closed allowlist, fail-closed: an unknown or absent tool name journals
    // nothing. Read-only tools land here by design (world-recoverable).
    if (typeof tool !== "string" || !(MUTATING_TOOLS as readonly string[]).includes(tool)) return null;
    const toolInput = (input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {}) as Record<string, unknown>;

    if (tool === "Bash") {
      // description ONLY — NEVER the command string, and never a fallback to
      // it. The command is argv: exactly where our leak history lives.
      const description = asNonEmptyString(toolInput.description);
      return { hook, tool, content: hardBound(description ? `bash: ${description}` : "bash: (no description)") };
    }

    // Write / Edit / NotebookEdit: file path only — never content, never
    // diffs. NotebookEdit's path key has appeared as both `notebook_path` and
    // `file_path` across harness doc generations — accept either; both are
    // paths, neither is content.
    const pathField = tool === "NotebookEdit" ? (toolInput.notebook_path ?? toolInput.file_path) : toolInput.file_path;
    const path = asNonEmptyString(pathField);
    const label = tool === "Write" ? "write" : tool === "Edit" ? "edit" : "notebook-edit";
    return { hook, tool: tool as MutatingTool, content: hardBound(path ? `${label}: ${path}` : `${label}: (no file path)`) };
  }

  if (hook === "Stop") {
    // Prefer a dedicated summary/intent field when the payload carries one
    // (intent-class by construction beats prose the agent happened to emit);
    // else the final assistant text. Both are assistant-chosen, user-visible
    // prose — never tool payloads — and both get the same hard bound.
    const source = asNonEmptyString(input.summary) ?? asNonEmptyString(input.last_assistant_message);
    if (!source) return null; // tool-only turn ⇒ no journal, no placeholder
    return { hook, content: hardBound(`stop: ${source.trim()}`) };
  }

  return null;
}

// ── journal row construction ────────────────────────────────────────────────

export function continuityTag(sessionId: string): string {
  return `${CONTINUITY_TAG_PREFIX}${sessionId}`;
}

export interface JournalRow {
  id: string;
  agentId: string;
  content: string;
  type: "session";
  durability: "ephemeral";
  /** EXPLICIT on every write — never the durability-keyed default. Hook-side
   *  half of the #1261 defense-in-depth pair (server guard is the other). */
  visibility: "private";
  tags: string[];
  sessionId: string;
  meta: { seq: number; processUUID: string; sessionId: string; hook: string; tool?: string };
  createdAt: string;
}

export function buildJournalRow(agentId: string, state: SessionState, plan: CapturePlan, now: Date = new Date()): JournalRow {
  const meta: JournalRow["meta"] = {
    seq: state.seq,
    processUUID: state.processUUID,
    sessionId: state.sessionId,
    hook: plan.hook,
  };
  if (plan.tool) meta.tool = plan.tool;
  return {
    id: `${agentId}-${randomUUID()}`,
    agentId,
    content: plan.content,
    type: "session",
    durability: "ephemeral",
    visibility: "private",
    tags: [continuityTag(state.sessionId)],
    sessionId: state.sessionId,
    meta,
    createdAt: now.toISOString(),
  };
}

// ── resume (agent-pull) ─────────────────────────────────────────────────────

/** Minimal client surface both hook binaries depend on (eases testing —
 *  structurally satisfied by the real FlairClient). */
export interface ContinuityClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

interface RawJournalRow {
  id?: string;
  agentId?: string;
  tags?: unknown;
  sessionId?: unknown;
  durability?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
  meta?: unknown;
  [key: string]: unknown;
}

export interface ResumeEntry {
  id: string;
  seq: number | null;
  processUUID: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface ResumeResult {
  /** The prior session's journal entries, seq-ordered — ONE process's entries
   *  only, never an interleave of two processUUIDs. */
  entries: ResumeEntry[];
  /** The session those entries belong to (for the hint's search tag). */
  sessionId: string | null;
}

/**
 * Fetch this agent's own ephemeral rows through the SUPPORTED read surface —
 * `GET /Memory?agentId=<id>` (the same verb the REM nightly runner's snapshot
 * step uses) — then filter client-side.
 *
 * This replaces the original `POST /Memory/search_by_conditions` read
 * (flair#1257 slice 3 fix): search_by_conditions is an ops-API operation, and
 * the Memory resource exposes no REST handler for that path — the POST 405s
 * ("does not have a post method... /Memory/search_by_conditions"), verified
 * against a real Harper in test/integration/continuity-rem-promotion-1257.
 * Because discoverResume fails open by design, that 405 didn't error — it
 * silently made EVERY resume come back empty (no hint, ever): the fail-open
 * masked a dead read path, exactly the "unrun check looks like a pass" shape.
 *
 * The client-side filters mirror what the old conditions asked the server
 * for: own agentId (the GET's query param is NOT an owner filter — the read
 * scope returns other agents' non-private rows too; journal rows are private
 * so only our own arrive, but the filter must not lean on that) and
 * durability "ephemeral".
 */
async function fetchOwnEphemeralRows(client: ContinuityClient, agentId: string): Promise<RawJournalRow[]> {
  const raw = await client.request("GET", `/Memory?agentId=${encodeURIComponent(agentId)}`);
  return rowsFrom(raw).filter((r) => r.agentId === agentId && r.durability === "ephemeral");
}

function rowsFrom(result: unknown): RawJournalRow[] {
  if (Array.isArray(result)) return result as RawJournalRow[];
  const wrapped = (result as { results?: unknown[] } | null)?.results;
  return Array.isArray(wrapped) ? (wrapped as RawJournalRow[]) : [];
}

/** Expired rows are excluded HERE, not just by MemoryMaintenance — the reap is
 *  asynchronous, so a row whose expiresAt is past may still be in storage
 *  (scenario S4: it must never reach the agent regardless). */
function isLive(row: RawJournalRow, now: Date): boolean {
  if (typeof row.expiresAt !== "string" || row.expiresAt === "") return true;
  const expiry = Date.parse(row.expiresAt);
  return !Number.isFinite(expiry) || expiry > now.getTime();
}

function continuitySessionOf(row: RawJournalRow): string | null {
  const meta = row.meta as { sessionId?: unknown; processUUID?: unknown; seq?: unknown } | null | undefined;
  if (meta && typeof meta.sessionId === "string" && meta.sessionId !== "") return meta.sessionId;
  if (Array.isArray(row.tags)) {
    for (const tag of row.tags) {
      if (typeof tag === "string" && tag.startsWith(CONTINUITY_TAG_PREFIX)) {
        const sid = tag.slice(CONTINUITY_TAG_PREFIX.length);
        if (sid !== "") return sid;
      }
    }
  }
  return null;
}

function toEntry(row: RawJournalRow): ResumeEntry {
  const meta = row.meta as { seq?: unknown; processUUID?: unknown; sessionId?: unknown } | null | undefined;
  return {
    id: typeof row.id === "string" ? row.id : "",
    seq: meta && typeof meta.seq === "number" && Number.isFinite(meta.seq) ? meta.seq : null,
    processUUID: meta && typeof meta.processUUID === "string" && meta.processUUID !== "" ? meta.processUUID : null,
    sessionId: continuitySessionOf(row),
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}

/** seq ascending (monotonic per process — the primary order), createdAt as
 *  tiebreak ONLY (and as the order for legacy rows lacking a seq). */
function seqOrder(a: ResumeEntry, b: ResumeEntry): number {
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return 0;
}

/**
 * Resume discovery, both layers as ruled on the issue:
 *
 *   FAST PATH — the pointer file named a prior session: search exactly that
 *   session's tag. A session's rows are all one process's by construction
 *   (sessionId is minted per process), so the tag IS the process filter.
 *
 *   FALLBACK — no (readable) pointer: agentId-wide ephemeral search,
 *   disambiguated by the processUUID carried in row meta. Entries are grouped
 *   by processUUID and ONLY the most recent group is returned — a resume
 *   reconstruction MUST NEVER interleave entries from two distinct
 *   processUUIDs (scenario S8; two live processes sharing an identity).
 *   Rows without a processUUID cannot be attributed and are skipped.
 *
 * Every failure (Flair down, auth error, malformed response) resolves to zero
 * entries — the caller then emits no hint. Never throws.
 */
export async function discoverResume(
  client: ContinuityClient,
  agentId: string,
  pointer: SessionPointer | null,
  now: Date = new Date(),
): Promise<ResumeResult> {
  try {
    if (pointer) {
      const priorTag = continuityTag(pointer.sessionId);
      const rows = (await fetchOwnEphemeralRows(client, agentId))
        .filter((r) => Array.isArray(r.tags) && (r.tags as unknown[]).includes(priorTag))
        .filter((r) => isLive(r, now));
      const entries = rows.map(toEntry).sort(seqOrder).slice(0, RESUME_SEARCH_LIMIT);
      return { entries, sessionId: entries.length > 0 ? pointer.sessionId : null };
    }

    const rows = (await fetchOwnEphemeralRows(client, agentId))
      .filter((r) => isLive(r, now))
      .filter((r) => continuitySessionOf(r) !== null)
      .slice(0, FALLBACK_SEARCH_LIMIT);
    const groups = new Map<string, ResumeEntry[]>();
    for (const row of rows) {
      const entry = toEntry(row);
      if (!entry.processUUID) continue; // unattributable — never guess
      const list = groups.get(entry.processUUID) ?? [];
      list.push(entry);
      groups.set(entry.processUUID, list);
    }
    let best: ResumeEntry[] | null = null;
    let bestLatest = "";
    for (const list of groups.values()) {
      const latest = list.reduce((max, e) => (e.createdAt > max ? e.createdAt : max), "");
      if (best === null || latest > bestLatest) {
        best = list;
        bestLatest = latest;
      }
    }
    if (!best || best.length === 0) return { entries: [], sessionId: null };
    const entries = [...best].sort(seqOrder).slice(0, RESUME_SEARCH_LIMIT);
    return { entries, sessionId: entries[0]?.sessionId ?? null };
  } catch {
    return { entries: [], sessionId: null };
  }
}

/**
 * The resume hint — at most ONE line, informational, agent-pull (scenario
 * S10): it names the count and the search tag, and NEVER carries journal
 * content (not even summarized). Zero entries ⇒ null ⇒ the hook emits no hint
 * at all — an empty journal is normal operation, not a warning.
 */
export function buildResumeHint(result: ResumeResult): string | null {
  const n = result.entries.length;
  if (n === 0 || !result.sessionId) return null;
  const noun = n === 1 ? "entry" : "entries";
  return `Continuity: ${n} short-term journal ${noun} from your previous session survived — search memory tag "${continuityTag(result.sessionId)}" if you need to recall what dropped from context.`;
}

// ── SessionStart-side boot plumbing ─────────────────────────────────────────

/** The SessionStart payload fields the boot path reads. The "how did this
 *  session start" discriminator has appeared as both `source` and
 *  `how_started` across harness doc generations — read either. */
export interface ContinuityBootInput {
  source?: unknown;
  how_started?: unknown;
  session_id?: unknown;
  [key: string]: unknown;
}

export interface ContinuityBoot {
  active: boolean;
  priorPointer: SessionPointer | null;
}

/**
 * Filesystem half of the resume path (pointer read → mint → rotate → seed the
 * capture state file), called by the SessionStart hook. Pure local work —
 * runs regardless of Flair reachability so capture always has its state file.
 * Never throws; any fs failure degrades to "resume hint may still fire,
 * capture won't" — fail-open in both directions.
 *
 * COMPACTION IS NOT A RESTART (scenario S7): when the harness reports the
 * session start came from compaction, NOTHING runs — no pointer read, no
 * rotation, no state-file touch. The harness session id is unchanged across
 * compaction, so the capture hook keeps finding the same state file and the
 * same sessionId; the journal never fragments.
 */
export function prepareContinuityBoot(
  input: ContinuityBootInput,
  agentId: string,
  env: Record<string, string | undefined> = process.env,
): ContinuityBoot {
  const startedFrom = typeof input.source === "string" ? input.source : typeof input.how_started === "string" ? input.how_started : "";
  if (startedFrom === "compact") return { active: false, priorPointer: null };
  // Without a harness session id there is nothing to key the capture state
  // file by (manual runs, older harnesses) — stay fully inert.
  if (!isSafeFileId(agentId) || !isSafeFileId(input.session_id)) return { active: false, priorPointer: null };

  const sessionDir = resolveSessionDir(env);
  const priorPointer = readPointer(sessionDir, agentId);
  try {
    seedSession(sessionDir, agentId, input.session_id);
  } catch {
    // Session dir unwritable — capture can't run this session, but a resume
    // hint from the prior pointer is still valid and still cheap.
  }
  return { active: true, priorPointer };
}
