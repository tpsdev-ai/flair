#!/usr/bin/env node

/**
 * Flair PreCompact hook for Claude Code (flair#2069): save one bounded
 * continuity record before context is lost, so the next session start shows
 * it first. The record's content, bounds, redaction, storage and dedup are
 * defined in ./precompact.ts; this file is the binary around them.
 *
 * PER RUN
 * -------
 *   1. Reads Claude Code's PreCompact payload on stdin: `hook_event_name`
 *      ("PreCompact"), `session_id`, `transcript_path` and `trigger`
 *      ("manual" for /compact, "auto" for automatic compaction).
 *   2. Finds this harness session's continuity state (seeded by
 *      flair-session-start) and consumes a journal seq, exactly as
 *      flair-continuity-capture does.
 *   3. Reads the transcript TAIL (bounded in bytes and lines) and builds the
 *      record: standing instructions, open tasks, in-flight work and the last
 *      assistant message, redacted and cut to the record bound. Nothing to
 *      record: nothing written.
 *   4. Resolves the record id through the local marker (a rerun of the same
 *      compaction reuses it), writes the marker, then writes the row with a
 *      signed `PUT /Memory/<id>` as the agent's own Ed25519 identity.
 *
 * NEVER BLOCKS COMPACTION
 * -----------------------
 * Claude Code blocks compaction when a PreCompact hook exits 2 or prints a
 * `decision: "block"` object. This binary does neither on any path: it exits 0
 * and prints either nothing or ONE `{"systemMessage": …}` object (a warning
 * Claude Code shows the user). The time budget (FLAIR_PRECOMPACT_TIMEOUT_MS,
 * default 5 s) covers the whole process from its start: the entry point arms a
 * process-level deadline before reading stdin, and when it passes the hook
 * prints the one timeout note and exits 0, whatever is still
 * pending (stdin held open, a slow read, a write in flight). stdin is read up
 * to STDIN_MAX_BYTES; a larger payload is ignored. What runs before this
 * process starts (the launcher, node's start-up) is outside the budget.
 *
 * NOTES (the only output)
 * -----------------------
 * Silent: a probe, a malformed or non-PreCompact payload, no FLAIR_AGENT_ID,
 * a tail with nothing to record, and success. One note, naming the reason: no
 * continuity state for the session, an unreadable transcript, a marker that
 * could not be read or written, and a write that failed (with its kind:
 * auth, timeout, unreachable or http-<status>, never a message text, URL or
 * credential).
 *
 * IDENTITY
 * --------
 * The agent's own key, resolved like the other hooks (FLAIR_AGENT_ID +
 * FLAIR_KEY_PATH or the standard key locations). The client is built with an
 * empty admin pair, which turns off flair-client's FLAIR_ADMIN_USER /
 * FLAIR_ADMIN_PASSWORD Basic fallback: the record is written as the agent or
 * not at all.
 *
 * CONFIG (env)
 *   FLAIR_AGENT_ID  (required; absent → silent no-op)
 *   FLAIR_URL       (default via flair-client)
 *   FLAIR_KEY_PATH  (default ~/.flair/keys/<agent>.key via flair-client)
 *   FLAIR_PRECOMPACT_TIMEOUT_MS (default 5000; 250..15000)
 *   FLAIR_SESSION_DIR (default ~/.flair/session; tests)
 *   FLAIR_HOOK_PROBE (probe mode: exit 0 before stdin, files or network)
 */

import { isProbeMode, readEnvOrUnset, stripInterpolationLiteralsFromEnv } from "./env-guard.js";
import { memoryPutPath } from "./record-id-path.js";
import { bumpSeq, isSafeFileId, resolveSessionDir, type ContinuityClient } from "./continuity.js";
import {
  PRECOMPACT_HOOK,
  buildPreCompactContent,
  buildPreCompactRow,
  extractFromTranscript,
  normalizeTrigger,
  precompactMarkerPath,
  readPreCompactMarker,
  readTranscriptTail,
  resolvePreCompactRecordId,
  writePreCompactMarker,
} from "./precompact.js";

type Env = Record<string, string | undefined>;

export const ENV_PRECOMPACT_TIMEOUT_MS = "FLAIR_PRECOMPACT_TIMEOUT_MS";
export const DEFAULT_PRECOMPACT_TIMEOUT_MS = 5000;
export const PRECOMPACT_TIMEOUT_FLOOR_MS = 250;
export const PRECOMPACT_TIMEOUT_CEILING_MS = 15_000;
/** Upper bound on the hook's stdin (the PreCompact payload is a few hundred bytes). */
export const STDIN_MAX_BYTES = 256 * 1024;

/** The whole-process budget: FLAIR_PRECOMPACT_TIMEOUT_MS when in range, else the default. */
export function resolvePreCompactBudgetMs(env: Env = process.env): number {
  const raw = readEnvOrUnset(ENV_PRECOMPACT_TIMEOUT_MS, env as NodeJS.ProcessEnv);
  const n = raw != null && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= PRECOMPACT_TIMEOUT_FLOOR_MS && n <= PRECOMPACT_TIMEOUT_CEILING_MS
    ? n
    : DEFAULT_PRECOMPACT_TIMEOUT_MS;
}

// ── failure → one note ──────────────────────────────────────────────────────

/** The hook's OWN budget timer. Recognized by identity, never by message. */
export class PreCompactTimeoutError extends Error {
  constructor() {
    super("precompact timeout");
    this.name = "PreCompactTimeoutError";
  }
}

export type PreCompactFailureKind = "auth" | "timeout" | "unreachable" | `http-${number}`;

/** Same rules as the session-start classifier (flair#1943): a numeric HTTP
 *  status first (401/403 → auth), then the hook's own timer or an error named
 *  exactly TimeoutError, else unreachable. Message text is never read. */
export function classifyPreCompactFailure(err: unknown): PreCompactFailureKind {
  const e = err as { status?: unknown; status_code?: unknown; statusCode?: unknown; name?: unknown } | null;
  for (const key of ["status", "status_code", "statusCode"] as const) {
    const v = e?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v === 401 || v === 403 ? "auth" : `http-${v}`;
  }
  if (err instanceof PreCompactTimeoutError) return "timeout";
  if (typeof e?.name === "string" && e.name === "TimeoutError") return "timeout";
  return "unreachable";
}

/** The hook's only non-empty output: ONE JSON object with a `systemMessage`
 *  (shown to the user). Never a `decision` field: that could block compaction. */
export function preCompactNote(text: string): string {
  return JSON.stringify({ systemMessage: text });
}

/** The note for a write that did not succeed. A timeout is worded as unknown,
 *  not as a failure: the server may still complete a write the hook stopped
 *  waiting for (a rerun then updates that same record). */
export function writeFailedNote(kind: PreCompactFailureKind): string {
  const what =
    kind === "timeout"
      ? "saving the pre-compaction continuity record did not finish in time (timeout), so it may be missing"
      : `the pre-compaction continuity record was not saved (${kind})`;
  return preCompactNote(`Flair: ${what}; compaction goes ahead. Check Flair with \`flair doctor\`.`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PreCompactTimeoutError()), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── core ────────────────────────────────────────────────────────────────────

export type PreCompactReason =
  | "malformed-input"
  | "not-precompact"
  | "no-agent-id"
  | "bad-session-id"
  | "no-state"
  | "no-transcript"
  | "nothing-to-record"
  | "marker-unreadable"
  | "marker-unwritable"
  | "write-failed"
  | "written";

export interface PreCompactOutcome {
  /** The exact string the binary prints ("" prints nothing). */
  output: string;
  /** Why. Diagnostic only: the exit code is 0 regardless. */
  reason: PreCompactReason;
  /** The record id, once one was resolved. */
  recordId?: string;
  /** True when a rerun reused the marker's record id. */
  reused?: boolean;
}

/** Local STRUCTURAL type for the client constructor (see the matching note in
 *  ./continuity-capture-hook.ts: this module must load without flair-client's
 *  built dist). */
interface FlairClientConstructor {
  new (config: {
    agentId: string;
    url?: string;
    keyPath?: string;
    timeoutMs?: number;
    adminUser?: string;
    adminPassword?: string;
  }): ContinuityClient;
}

/** LAZY for the same reason as ./continuity-capture-hook.ts's factory: the root
 *  test lane imports this module before flair-client is built. Tests inject
 *  makeClient; only the real binary takes this path. */
async function defaultClientFactory(agentId: string, timeoutMs: number, env: Env): Promise<ContinuityClient> {
  // @ts-ignore -- resolvable only once flair-client's dist is built; see ./continuity-capture-hook.ts
  const mod = await import("@tpsdev-ai/flair-client");
  const FlairClient = mod.FlairClient as unknown as FlairClientConstructor;
  return new FlairClient({
    agentId,
    url: readEnvOrUnset("FLAIR_URL", env as NodeJS.ProcessEnv),
    keyPath: readEnvOrUnset("FLAIR_KEY_PATH", env as NodeJS.ProcessEnv),
    timeoutMs,
    adminUser: "",
    adminPassword: "",
  });
}

export interface PreCompactDeps {
  makeClient?: (agentId: string, timeoutMs: number, env: Env) => ContinuityClient | Promise<ContinuityClient>;
  env?: Env;
  sessionDir?: string;
  now?: () => Date;
  /** When the budget started (epoch ms). The entry point passes its own start. */
  startedAt?: number;
  /** The whole-process budget in ms (default: resolvePreCompactBudgetMs(env)). */
  budgetMs?: number;
}

/**
 * Core flow with injectable dependencies. Never throws for a failed read or
 * write; returns the exact output plus a diagnostic reason.
 */
export async function runPreCompact(rawInput: string, deps: PreCompactDeps = {}): Promise<PreCompactOutcome> {
  const startedAt = deps.startedAt ?? Date.now();
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const budgetMs = deps.budgetMs ?? resolvePreCompactBudgetMs(env);

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { output: "", reason: "malformed-input" };
    input = parsed as Record<string, unknown>;
  } catch {
    return { output: "", reason: "malformed-input" };
  }
  if (input.hook_event_name !== PRECOMPACT_HOOK) return { output: "", reason: "not-precompact" };

  const agentId = readEnvOrUnset("FLAIR_AGENT_ID", env as NodeJS.ProcessEnv);
  if (!agentId || !isSafeFileId(agentId)) return { output: "", reason: "no-agent-id" };
  const harnessSessionId = input.session_id;
  if (!isSafeFileId(harnessSessionId)) return { output: "", reason: "bad-session-id" };
  const trigger = normalizeTrigger(input.trigger);

  // The session's continuity state, seeded by flair-session-start. Consuming a
  // seq orders the record inside the session's journal.
  const sessionDir = deps.sessionDir ?? resolveSessionDir(env);
  const state = bumpSeq(sessionDir, agentId, harnessSessionId, now());
  if (!state) {
    return {
      output: preCompactNote(
        "Flair: no continuity state for this session, so no pre-compaction record was saved. flair-session-start creates it when a session starts.",
      ),
      reason: "no-state",
    };
  }

  const tail = await readTranscriptTail(input.transcript_path);
  if (!tail.ok) {
    return {
      output: preCompactNote(`Flair: the transcript could not be read (${tail.reason}), so no pre-compaction record was saved.`),
      reason: "no-transcript",
    };
  }
  const content = buildPreCompactContent(extractFromTranscript(tail.lines), trigger);
  if (content === null) return { output: "", reason: "nothing-to-record" };

  // Dedup: an unreadable marker is NOT "no marker". Treating it as absent would
  // license a second record for a compaction that already has one.
  const markerPath = precompactMarkerPath(sessionDir, agentId);
  const read = readPreCompactMarker(sessionDir, agentId);
  if (read.kind === "unknown") {
    return {
      output: preCompactNote(
        `Flair: the pre-compaction marker ${markerPath} could not be read (${read.detail}), so no record was saved. Remove that file to reset it.`,
      ),
      reason: "marker-unreadable",
    };
  }
  const at = now();
  const resolved = resolvePreCompactRecordId(read.kind === "present" ? read.marker : null, harnessSessionId, trigger, agentId, at);
  try {
    writePreCompactMarker(sessionDir, agentId, {
      harnessSessionId,
      sessionId: state.sessionId,
      trigger,
      recordId: resolved.recordId,
      firstWrittenAt: resolved.firstWrittenAt,
    });
  } catch {
    return {
      output: preCompactNote(
        `Flair: the pre-compaction marker ${markerPath} could not be written, so no record was saved (a rerun could not be recognized).`,
      ),
      reason: "marker-unwritable",
      recordId: resolved.recordId,
    };
  }

  const row = buildPreCompactRow(agentId, state, resolved.recordId, content, trigger, at);
  const remainingMs = startedAt + budgetMs - Date.now();
  if (remainingMs <= 0) {
    return { output: writeFailedNote("timeout"), reason: "write-failed", recordId: row.id, reused: resolved.reused };
  }
  const makeClient = deps.makeClient ?? defaultClientFactory;
  try {
    await withTimeout(
      (async () => {
        const client = await makeClient(agentId, remainingMs, env);
        await client.request("PUT", memoryPutPath(row.id), row);
      })(),
      remainingMs,
    );
  } catch (err) {
    return { output: writeFailedNote(classifyPreCompactFailure(err)), reason: "write-failed", recordId: row.id, reused: resolved.reused };
  }
  return { output: "", reason: "written", recordId: row.id, reused: resolved.reused };
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Read stdin up to `maxBytes`: the text on EOF, or null as soon as it is
 *  larger (stdin is then closed). No timer here: stdin held open is bounded
 *  by the process-level deadline armed in main(). */
function readStdin(maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    process.stdin.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += bytes.length;
      if (size > maxBytes) {
        process.stdin.destroy();
        settle(null);
        return;
      }
      chunks.push(bytes);
    });
    process.stdin.on("end", () => settle(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => settle(Buffer.concat(chunks).toString("utf8")));
  });
}

/** How long to wait for stdout to drain before exiting anyway. */
const STDOUT_DRAIN_GRACE_MS = 1000;

let finished = false;

/** Print the output (possibly nothing) and end the process with exit 0 once
 *  the write drains. The first caller wins: the deadline and the normal path
 *  can both get here, and only one output may be written. Explicit, so an
 *  abandoned request cannot keep the process alive past the budget. */
function finish(output: string): void {
  if (finished) return;
  finished = true;
  let done = false;
  const exit = (): void => {
    if (done) return;
    done = true;
    process.exit(0);
  };
  process.stdout.on("error", exit);
  try {
    process.stdout.write(output, exit);
  } catch {
    exit();
  }
  setTimeout(exit, STDOUT_DRAIN_GRACE_MS).unref?.();
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // Probe mode (flair#1007 pattern): being reached is the whole answer.
  if (isProbeMode()) {
    finish("");
    return;
  }
  stripInterpolationLiteralsFromEnv();
  const budgetMs = resolvePreCompactBudgetMs(process.env);
  // The process-level deadline, armed before stdin is read.
  const expired = readEnvOrUnset("FLAIR_AGENT_ID") ? writeFailedNote("timeout") : "";
  setTimeout(() => finish(expired), budgetMs);
  let output = "";
  try {
    const input = await readStdin(STDIN_MAX_BYTES);
    if (input !== null) output = (await runPreCompact(input, { startedAt, budgetMs })).output;
  } catch {
    output = "";
  }
  finish(output);
}

// Only run when executed as a script, not when imported by tests.
const importMeta = import.meta as ImportMeta & { main?: boolean };
const isMain =
  importMeta.main === true ||
  (typeof process !== "undefined" &&
    process.argv[1] != null &&
    import.meta.url === `file://${process.argv[1]}`);

if (isMain) {
  void main().catch(() => finish(""));
}
