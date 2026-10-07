/**
 * Capture spool (flair#2068) — the local, bounded, private staging area the
 * capture hook appends to on the hot path, and the background flush that
 * attempts staged candidates through Flair's normal write path.
 *
 * The file layout is per agent id:
 *   <dir>/<agentId>.spool.json    staged candidates (bounded)
 *   <dir>/<agentId>.pending.json  failed commands awaiting a matching follow-up (bounded)
 *   <dir>/<agentId>.flush.stamp   last background-flush time (cooldown)
 *   <dir>/<agentId>.lock
 */

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readEnvOrUnset, stripInterpolationLiteralsFromEnv } from "./env-guard.js";
import { memoryPutPath } from "./record-id-path.js";
import {
  CAPTURE_VERSION,
  buildCaptureMemoryRow,
  planPostToolUse,
  planPostToolUseFailure,
  planStop,
  type CaptureCandidate,
  type CaptureHookInput,
  type PendingError,
} from "./capture.js";

// ── bounds ──────────────────────────────────────────────────────────────────

/** At most this many staged candidates; the oldest is evicted past it. */
export const CAPTURE_SPOOL_MAX_RECORDS = 100;

/** At most this many bytes of spool JSON; records are dropped from the oldest
 *  end until it fits. */
export const CAPTURE_SPOOL_MAX_BYTES = 64 * 1024;

/** At most this many pending errors. */
export const CAPTURE_PENDING_MAX = 8;

export const CAPTURE_FLUSH_COOLDOWN_MS = 1000;

/** The largest hook payload read from stdin; a larger one is not captured. */
export const CAPTURE_STDIN_MAX_BYTES = 1 * 1024 * 1024;

/** How long a hook waits for the per-agent lock before it captures nothing. */
export const CAPTURE_LOCK_WAIT_MS = 200;

export const CAPTURE_LOCK_STALE_MS = 5000;

// ── paths ───────────────────────────────────────────────────────────────────

/** Where the spool lives. FLAIR_CAPTURE_DIR overrides the default. */
export function resolveCaptureDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.FLAIR_CAPTURE_DIR;
  if (typeof override === "string" && override.trim() !== "") return override;
  const home = typeof env.HOME === "string" && env.HOME !== "" ? env.HOME : homedir();
  return join(home, ".flair", "capture");
}

function isSafeFileId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

export function spoolPath(dir: string, agentId: string): string {
  return join(dir, `${agentId}.spool.json`);
}

export function pendingPath(dir: string, agentId: string): string {
  return join(dir, `${agentId}.pending.json`);
}

export function flushStampPath(dir: string, agentId: string): string {
  return join(dir, `${agentId}.flush.stamp`);
}

export function lockPath(dir: string, agentId: string): string {
  return join(dir, `${agentId}.lock`);
}

function writePrivate(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function atomicWritePrivate(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writePrivate(tmp, data);
  renameSync(tmp, path);
}

function ensureCaptureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

const LOCK_BUSY: unique symbol = Symbol("capture-lock-busy");
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Run `fn` holding the per-agent lock (an exclusively created file), or
 *  return LOCK_BUSY when it is not free within CAPTURE_LOCK_WAIT_MS. */
function withCaptureLock<T>(dir: string, agentId: string, fn: () => T): T | typeof LOCK_BUSY {
  ensureCaptureDir(dir);
  const path = lockPath(dir, agentId);
  const deadline = Date.now() + CAPTURE_LOCK_WAIT_MS;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd !== null) {
      closeSync(fd);
      try {
        return fn();
      } finally {
        try { unlinkSync(path); } catch {}
      }
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > CAPTURE_LOCK_STALE_MS) unlinkSync(path);
    } catch {
      // Released meanwhile.
    }
    if (Date.now() >= deadline) return LOCK_BUSY;
    Atomics.wait(sleepCell, 0, 0, 2);
  }
}

/** `fn` under the lock; "refused" when the lock is busy or `fn` throws. */
function underLock<T extends string>(dir: string, agentId: string, fn: () => T): T | "refused" {
  try {
    const result = withCaptureLock(dir, agentId, fn);
    return result === LOCK_BUSY ? "refused" : result;
  } catch {
    return "refused";
  }
}

// ── spool records ───────────────────────────────────────────────────────────

export interface CaptureSpoolRecord {
  v: number;
  agentId: string;
  kind: CaptureCandidate["kind"];
  content: string;
  dedupKey: string;
  provenance: CaptureCandidate["provenance"];
}

function isProvenance(value: unknown): value is CaptureCandidate["provenance"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  return (provenance.hook === "Stop" || provenance.hook === "PostToolUse" || provenance.hook === "PostToolUseFailure") &&
    typeof provenance.capturedAt === "string" && Number.isFinite(Date.parse(provenance.capturedAt)) &&
    ["tool", "sessionId", "cwd"].every((key) => provenance[key] === undefined || typeof provenance[key] === "string");
}

function isSpoolRecord(value: unknown, agentId: string): value is CaptureSpoolRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === CAPTURE_VERSION &&
    record.agentId === agentId &&
    (record.kind === "error-follow-up" || record.kind === "decision") &&
    typeof record.content === "string" &&
    typeof record.dedupKey === "string" && /^[a-f0-9]{64}$/.test(record.dedupKey) &&
    isProvenance(record.provenance)
  );
}

/** Read the staged records, tolerating a missing/malformed file as empty. */
export function readSpool(dir: string, agentId: string): CaptureSpoolRecord[] {
  try {
    const raw = readFileSync(spoolPath(dir, agentId), "utf-8");
    const parsed = JSON.parse(raw) as { records?: unknown };
    if (!parsed || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter((r) => isSpoolRecord(r, agentId));
  } catch {
    return [];
  }
}

function serializeSpool(agentId: string, records: CaptureSpoolRecord[]): string {
  return `${JSON.stringify({ v: CAPTURE_VERSION, agentId, records })}\n`;
}

function trimRecords(records: CaptureSpoolRecord[]): CaptureSpoolRecord[] {
  let kept = records.slice(-CAPTURE_SPOOL_MAX_RECORDS);
  while (kept.length > 0 && Buffer.byteLength(serializeSpool(kept[0]!.agentId, kept), "utf8") > CAPTURE_SPOOL_MAX_BYTES) {
    kept = kept.slice(1);
  }
  return kept;
}

/**
 * Append one candidate, deduplicating by `dedupKey` against what is already
 * staged. Returns "appended", "deduplicated" or "refused".
 */
export function appendRecord(dir: string, agentId: string, candidate: CaptureCandidate): "appended" | "deduplicated" | "refused" {
  return underLock(dir, agentId, () => appendRecordLocked(dir, agentId, candidate));
}

function appendRecordLocked(dir: string, agentId: string, candidate: CaptureCandidate): "appended" | "deduplicated" {
  const records = readSpool(dir, agentId);
  if (records.some((r) => r.dedupKey === candidate.dedupKey)) return "deduplicated";
  records.push({
    v: CAPTURE_VERSION,
    agentId,
    kind: candidate.kind,
    content: candidate.content,
    dedupKey: candidate.dedupKey,
    provenance: candidate.provenance,
  });
  atomicWritePrivate(spoolPath(dir, agentId), serializeSpool(agentId, trimRecords(records)));
  return "appended";
}

// ── pending errors ──────────────────────────────────────────────────────────

function readPending(dir: string, agentId: string): PendingError[] {
  try {
    const raw = readFileSync(pendingPath(dir, agentId), "utf-8");
    const parsed = JSON.parse(raw) as { pending?: unknown };
    if (!parsed || !Array.isArray(parsed.pending)) return [];
    return parsed.pending.filter((p): p is PendingError => {
      if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
      const record = p as Record<string, unknown>;
      return typeof record.signature === "string" && typeof record.command === "string" && typeof record.error === "string" && isProvenance(record.provenance);
    });
  } catch {
    return [];
  }
}

/** Caller holds the lock. */
function writePendingLocked(dir: string, agentId: string, pending: PendingError[]): void {
  atomicWritePrivate(pendingPath(dir, agentId), `${JSON.stringify({ v: CAPTURE_VERSION, pending: pending.slice(-CAPTURE_PENDING_MAX) })}\n`);
}


export interface CaptureDeps {
  env?: Record<string, string | undefined>;
  dir?: string;
  now?: () => Date;
  /** Injected by the entry point to kick a background flush; tests pass a spy. */
  kickFlush?: (agentId: string, dir: string) => void;
  warn?: (message: string) => void;
}

export interface CaptureOutcome {
  captured: boolean;
  reason: "appended" | "deduplicated" | "error-recorded" | "not-capturable" | "no-agent-id" | "malformed-input" | "refused";
}

/** Appends new candidates and invokes a supplied flush callback; pending errors, deduplicated candidates and uncapturable input do neither. */
export function runCapture(rawInput: string, deps: CaptureDeps = {}): CaptureOutcome {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();

  let input: CaptureHookInput;
  try {
    const parsed: unknown = JSON.parse(rawInput || "");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { captured: false, reason: "malformed-input" };
    }
    input = parsed as CaptureHookInput;
  } catch {
    return { captured: false, reason: "malformed-input" };
  }

  const agentId = readEnvOrUnset("FLAIR_AGENT_ID", env);
  if (!isSafeFileId(agentId)) return { captured: false, reason: "no-agent-id" };
  const dir = deps.dir ?? resolveCaptureDir(env);
  const capturedAt = now.toISOString();

  if (input.hook_event_name === "Stop") {
    const candidate = planStop(input, capturedAt);
    if (!candidate) return { captured: false, reason: "not-capturable" };
    const result = appendRecord(dir, agentId, candidate);
    if (result === "appended") deps.kickFlush?.(agentId, dir);
    return { captured: result !== "refused", reason: result };
  }

  if (input.hook_event_name === "PostToolUseFailure") {
    const error = planPostToolUseFailure(input, capturedAt);
    if (!error) return { captured: false, reason: "not-capturable" };
    const result = underLock(dir, agentId, () => {
      writePendingLocked(dir, agentId, [...readPending(dir, agentId), error]);
      return "error-recorded" as const;
    });
    return { captured: false, reason: result };
  }

  if (input.hook_event_name === "PostToolUse") {
    // Most successful calls resolve nothing: decide that without the lock.
    if (planPostToolUse(input, readPending(dir, agentId), capturedAt).action !== "candidate") {
      return { captured: false, reason: "not-capturable" };
    }
    const result = underLock(dir, agentId, () => {
      const pending = readPending(dir, agentId);
      const plan = planPostToolUse(input, pending, capturedAt);
      if (plan.action !== "candidate") return "not-capturable" as const;
      const appended = appendRecordLocked(dir, agentId, plan.candidate);
      writePendingLocked(dir, agentId, pending.filter((_, i) => i !== plan.resolved));
      return appended;
    });
    if (result === "appended") deps.kickFlush?.(agentId, dir);
    return { captured: result === "appended" || result === "deduplicated", reason: result };
  }

  return { captured: false, reason: "not-capturable" };
}

// ── background flush (the normal write path) ────────────────────────────────

/** The one client surface the flush touches — structurally satisfied by the
 *  real FlairClient, injectable in tests. */
export interface CaptureClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface FlushDeps {
  env?: Record<string, string | undefined>;
  dir?: string;
  now?: () => Date;
  makeClient?: (agentId: string) => CaptureClient | Promise<CaptureClient>;
  warn?: (message: string) => void;
}

export interface FlushOutcome {
  flushed: number;
  remaining: number;
  reason: "flushed" | "nothing" | "no-agent-id" | "write-failed";
}

/** LAZY on purpose: flair-client resolves via its built dist/, and this module
 *  must load and typecheck without that dist present. */
async function defaultClientFactory(agentId: string): Promise<CaptureClient> {
  // @ts-ignore -- resolvable only once flair-client's dist is built
  const mod = await import("@tpsdev-ai/flair-client");
  const FlairClient = mod.FlairClient as new (config: { agentId: string; url?: string; keyPath?: string }) => CaptureClient;
  return new FlairClient({
    agentId,
    url: readEnvOrUnset("FLAIR_URL"),
    keyPath: readEnvOrUnset("FLAIR_KEY_PATH"),
  });
}

export async function runCaptureFlush(deps: FlushDeps = {}): Promise<FlushOutcome> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? (() => {});
  const agentId = readEnvOrUnset("FLAIR_AGENT_ID", env);
  if (!isSafeFileId(agentId)) return { flushed: 0, remaining: 0, reason: "no-agent-id" };
  const dir = deps.dir ?? resolveCaptureDir(env);
  const records = readSpool(dir, agentId);
  if (records.length === 0) return { flushed: 0, remaining: 0, reason: "nothing" };

  const now = deps.now ?? (() => new Date());
  const makeClient = deps.makeClient ?? defaultClientFactory;
  let client: CaptureClient;
  try {
    client = await makeClient(agentId);
  } catch (error) {
    warn(`flush skipped (${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`);
    return { flushed: 0, remaining: records.length, reason: "write-failed" };
  }

  const written = new Set<string>();
  for (const record of records) {
    try {
      const row = buildCaptureMemoryRow(
        { kind: record.kind, content: record.content, dedupKey: record.dedupKey, provenance: record.provenance },
        agentId,
        now(),
      );
      await client.request("PUT", memoryPutPath(row.id), row);
      written.add(record.dedupKey);
    } catch (error) {
      warn(`capture write skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  let remaining = records.length;
  if (written.size > 0) {
    // Re-read under the lock and drop only what was written, so a record
    // appended while the writes were in flight is kept.
    try {
      const kept = withCaptureLock(dir, agentId, () => {
        const current = readSpool(dir, agentId).filter((r) => !written.has(r.dedupKey));
        atomicWritePrivate(spoolPath(dir, agentId), serializeSpool(agentId, current));
        return current.length;
      });
      if (kept !== LOCK_BUSY) remaining = kept;
    } catch {
    }
  }
  return { flushed: written.size, remaining, reason: written.size > 0 ? "flushed" : "write-failed" };
}

// ── flush cooldown ──────────────────────────────────────────────────────────

export function claimFlushSlot(dir: string, agentId: string, now: number, cooldownMs: number = CAPTURE_FLUSH_COOLDOWN_MS): boolean {
  try {
    const stamp = flushStampPath(dir, agentId);
    let last = 0;
    try {
      if (statSync(stamp).isFile()) last = Number(readFileSync(stamp, "utf-8")) || 0;
    } catch {
      last = 0;
    }
    if (now - last < cooldownMs) return false;
    ensureCaptureDir(dir);
    atomicWritePrivate(stamp, String(now));
    return true;
  } catch {
    return true;
  }
}

/** Re-exported for the entry point's env hygiene (see ./capture-hook.ts). */
export { stripInterpolationLiteralsFromEnv };
