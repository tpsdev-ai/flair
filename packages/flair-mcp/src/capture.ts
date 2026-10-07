import { createHash } from "node:crypto";

import { redactSecrets } from "./secret-redaction.js";

// ── bounds ──────────────────────────────────────────────────────────────────

export const CAPTURE_BOUND_CHARS = 400;

/** The one secret-shaped replacement the redactor emits, re-exported so callers
 *  and tests share the token rather than hard-coding it. */
export { REDACTED } from "./secret-redaction.js";

/** The capture record schema version, carried on every spool record. */
export const CAPTURE_VERSION = 1;

// ── types ───────────────────────────────────────────────────────────────────

/** Subset of the Claude Code hook payload the capture binary reads. It extracts
 *  ONLY these fields; the raw hook JSON is never stored or forwarded. */
export interface CaptureHookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  /** PostToolUseFailure payloads: the failure text, and whether the user
   *  interrupted the call. */
  error?: unknown;
  is_interrupt?: unknown;
  /** Stop payloads: the final assistant message text, when the harness
   *  provides it. */
  last_assistant_message?: unknown;
  [key: string]: unknown;
}

export type CaptureHookName = "PostToolUseFailure" | "PostToolUse" | "Stop";

export interface CaptureProvenance {
  hook: CaptureHookName;
  tool?: string;
  sessionId?: string;
  cwd?: string;
  capturedAt: string;
}

export interface CaptureCandidate {
  kind: "error-follow-up" | "decision";
  content: string;
  /** Deterministic identity of this learning. Two candidates derived from the
   *  same pair/sentence share it. */
  dedupKey: string;
  provenance: CaptureProvenance;
}

/** A failed command awaiting a possible matching follow-up, held locally (never in Flair) until the
 *  follow-up arrives or the bound evicts it. */
export interface PendingError {
  signature: string;
  command: string;
  error: string;
  /** The pending error's provenance (cwd/session) for the eventual memory. */
  provenance: CaptureProvenance;
}

export type PostToolUseAction =
  | { action: "candidate"; candidate: CaptureCandidate; resolved: number }
  | { action: "none" };

// ── bounding + redaction ────────────────────────────────────────────────────

export function hardBoundCapture(text: string, max: number = CAPTURE_BOUND_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Redact credential shapes, then collapse whitespace and hard-bound. */
export function cleanCaptureText(text: string, max: number = CAPTURE_BOUND_CHARS): string {
  return hardBoundCapture(redactSecrets(text).replace(/\s+/g, " ").trim(), max);
}

export function cleanCaptureTail(text: string, max: number = CAPTURE_BOUND_CHARS): string {
  const cleaned = cleanCaptureText(text, Number.POSITIVE_INFINITY);
  return cleaned.length <= max ? cleaned : `…${cleaned.slice(-max)}`;
}

export function captureHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The record id derived from a dedup key: deterministic, URL-safe, and short
 *  enough for a single `/Memory/<id>` path segment. Flushing the same
 *  candidate twice targets the same id. */
export function captureRecordId(dedupKey: string): string {
  return `cap-${dedupKey.slice(0, 32)}`;
}

// ── command signature + failure detection (PostToolUse) ──────────────────────

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function commandSignature(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const verb = tokens[0]!.split("/").pop()!.toLowerCase();
  if (!verb) return null;
  const rest = tokens.slice(1).find((t) => !t.startsWith("-"));
  return rest ? `${verb} ${rest.toLowerCase()}` : verb;
}

/** A path-shaped token appearing anywhere in a command, if any (used so an
 *  Edit/Write to a file named in a failure can match it). */
export function referencedPath(text: string): string | null {
  const match = text.match(/(?:^|\s)([A-Za-z0-9._/-]*\/[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})(?=\s|$)/);
  return match ? match[1]! : null;
}

/** The bounded, redacted tail of a PostToolUseFailure `error`, or null when
 *  there is none. */
export function failureExcerpt(error: unknown): string | null {
  const text = asNonEmptyString(error);
  return text ? cleanCaptureTail(text) : null;
}

function toolInputRecord(input: CaptureHookInput): Record<string, unknown> {
  return input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
    ? (input.tool_input as Record<string, unknown>)
    : {};
}

function provenanceFor(input: CaptureHookInput, hook: CaptureHookName, capturedAt: string, tool?: string): CaptureProvenance {
  const sessionId = asNonEmptyString(input.session_id);
  const cwd = asNonEmptyString(input.cwd);
  return {
    hook,
    ...(tool ? { tool } : {}),
    ...(sessionId ? { sessionId: cleanCaptureText(sessionId) } : {}),
    ...(cwd ? { cwd: cleanCaptureText(cwd) } : {}),
    capturedAt,
  };
}

/**
 * A successful tool call's summary, bounded + redacted — what a later
 * candidate memory names as a possible matching follow-up.
 */
function fixSummary(tool: string, toolInput: Record<string, unknown>): string | null {
  if (tool === "Bash") {
    const command = asNonEmptyString(toolInput.command);
    return command ? cleanCaptureText(command) : null;
  }
  const pathField = tool === "NotebookEdit" ? toolInput.notebook_path ?? toolInput.file_path : toolInput.file_path;
  const path = asNonEmptyString(pathField);
  return path ? cleanCaptureText(path) : null;
}

/** Does a successful call match one of the pending errors? */
function resolvingIndex(tool: string, toolInput: Record<string, unknown>, pending: PendingError[]): number {
  if (tool === "Bash") {
    const command = fixSummary(tool, toolInput);
    if (!command) return -1;
    const signature = commandSignature(command);
    for (let i = 0; i < pending.length; i++) {
      const candidate = pending[i]!;
      if (signature && candidate.signature === signature) return i;
      const path = referencedPath(command);
      if (path && (candidate.command.includes(path) || candidate.error.includes(path))) return i;
    }
    return -1;
  }
  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
    const path = fixSummary(tool, toolInput);
    if (!path) return -1;
    for (let i = 0; i < pending.length; i++) {
      const candidate = pending[i]!;
      if (candidate.command.includes(path) || candidate.error.includes(path) || candidate.provenance.cwd === path) return i;
    }
  }
  return -1;
}

function errorFixCandidate(error: PendingError, tool: string, toolInput: Record<string, unknown>, capturedAt: string): CaptureCandidate | null {
  const fix = fixSummary(tool, toolInput);
  if (!fix) return null;
  const content = cleanCaptureText(
    `A command failed. Failed: ${error.command}. Error: ${error.error}. Possible matching follow-up: ${fix}.`,
  );
  const dedupKey = captureHash(`error-follow-up\0${error.command}\0${fix}`);
  const provenance = provenanceFor({ session_id: error.provenance.sessionId, cwd: error.provenance.cwd }, "PostToolUse", capturedAt, tool);
  return { kind: "error-follow-up", content, dedupKey, provenance };
}

/**
 * Plan the PostToolUseFailure half: a failed Bash call becomes a pending error.
 * A call the user interrupted is not a failure to learn from.
 */
export function planPostToolUseFailure(input: CaptureHookInput, capturedAt: string): PendingError | null {
  if (input.tool_name !== "Bash" || input.is_interrupt === true) return null;
  const raw = asNonEmptyString(toolInputRecord(input).command);
  const error = failureExcerpt(input.error);
  if (!raw || !error) return null;
  const command = cleanCaptureText(raw);
  const signature = commandSignature(command);
  if (!signature) return null;
  return {
    signature,
    command,
    error,
    provenance: provenanceFor(input, "PostToolUseFailure", capturedAt, "Bash"),
  };
}

/**
 * Plan the PostToolUse half: a successful call that matches a pending error
 * turns it into a single candidate.
 */
export function planPostToolUse(input: CaptureHookInput, pending: PendingError[], capturedAt: string): PostToolUseAction {
  const tool = input.tool_name;
  if (typeof tool !== "string") return { action: "none" };
  const toolInput = toolInputRecord(input);
  if (tool === "Bash" || tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
    const index = resolvingIndex(tool, toolInput, pending);
    if (index >= 0) {
      const candidate = errorFixCandidate(pending[index]!, tool, toolInput, capturedAt);
      if (candidate) return { action: "candidate", candidate, resolved: index };
    }
  }
  return { action: "none" };
}

// ── decision extraction (Stop) ──────────────────────────────────────────────

const DECISION_CUES =
  /\b(?:decision|decided|we(?:'ll| will| should) use|instead of|correction|correcting|i was wrong|chose|choose to|prefer(?:red)?|the right approach|note to self|going forward|from now on|to be clear|we agreed)\b/i;

export function extractDecision(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 8) continue;
    if (DECISION_CUES.test(trimmed)) return cleanCaptureText(trimmed);
  }
  return null;
}

/** Plan the Stop half: at most one decision candidate, or null. */
export function planStop(input: CaptureHookInput, capturedAt: string): CaptureCandidate | null {
  const text = asNonEmptyString(input.last_assistant_message);
  if (!text) return null;
  const decision = extractDecision(text);
  if (!decision) return null;
  return {
    kind: "decision",
    content: decision,
    dedupKey: captureHash(`decision\0${decision}`),
    provenance: provenanceFor(input, "Stop", capturedAt),
  };
}

// ── the memory row a candidate flushes into ─────────────────────────────────

export interface CaptureMemoryRow {
  id: string;
  agentId: string;
  content: string;
  type: "lesson" | "decision";
  durability: "persistent";
  visibility: "private";
  tags: string[];
  meta: {
    source: "claude-code-capture";
    hook: CaptureHookName;
    dedupKey: string;
    capturedAt: string;
    tool?: string;
    sessionId?: string;
  };
  createdAt: string;
}

export function buildCaptureMemoryRow(candidate: CaptureCandidate, agentId: string, now: Date = new Date()): CaptureMemoryRow {
  return {
    id: captureRecordId(candidate.dedupKey),
    agentId,
    content: candidate.content,
    type: candidate.kind === "decision" ? "decision" : "lesson",
    durability: "persistent",
    visibility: "private",
    tags: ["flair:capture", `flair:capture:${candidate.kind}`],
    meta: {
      source: "claude-code-capture",
      hook: candidate.provenance.hook,
      dedupKey: candidate.dedupKey,
      capturedAt: candidate.provenance.capturedAt,
      ...(candidate.provenance.tool ? { tool: candidate.provenance.tool } : {}),
      ...(candidate.provenance.sessionId ? { sessionId: cleanCaptureText(candidate.provenance.sessionId) } : {}),
    },
    createdAt: now.toISOString(),
  };
}
