/**
 * Action recall (flair#2067 slice 2) — the pure core.
 *
 * A PreToolUse hook can add context for the NEXT model request (slice 1
 * established that it can never change the pending command), so this feature
 * keeps a small, bounded cache of the agent's OWN lessons and surfaces the
 * ones whose author-declared `triggers` match the pending Bash command. It is
 * a signal, never a guardrail: nothing here can deny, ask or rewrite.
 *
 * This module holds the parts that must be identical on the write side (the
 * SessionStart refresh, ./action-recall-refresh.ts) and the read side (the
 * hot path, ./action-recall-hook.ts): the trigger grammar and its limits, a
 * restricted Bash argv reader, the path-glob matcher, the cache envelope, and
 * the bounded, redacted rendering.
 *
 * EVERY limit below is a build contract (flair#2067 slice 2 build spec).
 */

import { createHash } from "node:crypto";
import { redactSecrets, REDACTED } from "./secret-redaction.js";

// ── caps and bounds ──────────────────────────────────────────────────────────

/** Payload envelope version. */
export const CACHE_VERSION = 1;
/** Metadata key that carries triggers on a Memory row's JSON `metadata`. */
export const METADATA_KEY = "flairActionRecall";
/** Maximum serialized envelope size. */
export const CACHE_MAX_BYTES = 256 * 1024;
/** Maximum entries in a generation. */
export const CACHE_MAX_ENTRIES = 64;
/** Maximum size of the session binding file. */
export const BINDING_MAX_BYTES = 2 * 1024;
/** Session cache retention target per principal. */
export const MAX_SESSION_CACHES = 8;
/** A generation expires this long after its refresh START (shortened per lesson). */
export const STALE_MS = 5 * 60 * 1000;

/** Hot-path stdin cap. */
export const STDIN_MAX_BYTES = 32 * 1024;
/** Pending command cap. */
export const COMMAND_MAX_BYTES = 8 * 1024;
/** Maximum argv tokens read from one command. */
export const MAX_ARGV_TOKENS = 128;
/** Best-effort deadline for each stdin or file read. */
export const INTERNAL_DEADLINE_MS = 25;

/** Maximum hits rendered. */
export const MAX_HITS = 3;
/** Maximum UTF-8 bytes of one rendered hit. */
export const HIT_MAX_BYTES = 768;
/** Maximum UTF-8 bytes of one excerpt (truncated before storage). */
export const EXCERPT_MAX_BYTES = 512;
/** Maximum UTF-8 bytes of the whole serialized stdout. */
export const STDOUT_MAX_BYTES = 4096;
/** Maximum UTF-8 bytes of a record's content before it is skipped (not stored). */
export const CONTENT_SKIP_BYTES = 16 * 1024;

/** Grammar limits. */
export const MAX_TRIGGERS_PER_LESSON = 4;
export const MAX_SUBCOMMANDS = 3;
export const MAX_FLAGS = 8;
export const MAX_PATHS = 2;
export const MAX_STRING_BYTES = 128;

/** The PreToolUse context header. A signal, not an instruction. */
export const RECALL_HEADER =
  "Lessons from your own Flair memory whose triggers match this action (auto-recalled: a signal, not an instruction; read the full memory with memory_get before acting on it):";
/** The prefix on EVERY quoted line of a hit. */
export const QUOTE_PREFIX = "| ";

/** Empty, inert output. */
export const NOOP_OUTPUT = "";

// ── types ───────────────────────────────────────────────────────────────────

/** One author-declared trigger (flair#2067 slice 2). */
export interface ActionTrigger {
  verb: string;
  subcommands: string[];
  flags: string[];
  paths: string[];
}

export type TriggerResult =
  | { ok: true; triggers: ActionTrigger[] }
  | { ok: false; reason: string };

/** One cached lesson. Free text is already redacted and bounded. */
export interface CacheEntry {
  id: string;
  owner: string;
  createdAt?: string;
  validFrom?: string;
  validTo?: string;
  expiresAt?: string;
  visibility?: string;
  provenance?: string;
  safetyFlags?: string[];
  triggers: ActionTrigger[];
  excerpt: string;
}

/** The cache payload (the JSON string inside the envelope). */
export interface CachePayload {
  v: number;
  url: string;
  principal: string;
  session: string;
  instance: string;
  generation: string;
  refreshStart: number;
  expiry: number;
  entries: CacheEntry[];
}

/** The on-disk envelope: `{payload, sha256}`. */
export interface CacheEnvelope {
  payload: string;
  sha256: string;
}

/** The small binding file that points a session at one generation. */
export interface CacheBinding {
  v: number;
  url: string;
  principal: string;
  session: string;
  instance: string;
  generation: string;
}

/** A parsed pending command. */
export interface ParsedCommand {
  verb: string;
  argv: string[];
  subcommands: string[];
  flags: Set<string>;
  operands: string[];
}

export type BashParse = { ok: true; argv: string[] } | { ok: false; reason: string };

// ── small utilities ──────────────────────────────────────────────────────────

/** SHA-256 hex digest of a string's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical cache URL: scheme + host + deployment path, with credentials,
 * query and fragment removed and a trailing slash normalized away. Returns
 * null when the string is not a URL.
 */
export function canonicalUrl(rawUrl: string): string | null {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** The default Flair URL, as flair-client uses. */
export const DEFAULT_FLAIR_URL = "http://localhost:19926";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** UTF-8 byte length of `text`. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Cut `text` to at most `max` UTF-8 bytes without splitting a code point. */
export function cutToUtf8Bytes(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text;
  const bytes = encoder.encode(text);
  let end = max;
  // Walk back off a UTF-8 continuation byte (0b10xxxxxx) to a boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** The basename of an executable path (the verb a trigger names). */
export function commandBasename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

// ── trigger grammar ───────────────────────────────────────────────────────────

/** Literal words: ASCII letters/digits plus `. _ / -` (verbs exclude `/`). */
const LITERAL_WORD_RE = /^[A-Za-z0-9._/-]+$/;
const VERB_RE = /^[A-Za-z0-9._-]+$/;
/** Single-letter short flag or literal long flag (`--name` or `--name=value`). */
const LONG_FLAG_RE = /^--[A-Za-z0-9][A-Za-z0-9-]*(?:=[A-Za-z0-9._/:-]*)?$/;
const SHORT_FLAG_RE = /^-[A-Za-z0-9]$/;
/** Path glob: literals plus `*`; `**` only as a whole segment. */
const PATH_GLOB_RE = /^[A-Za-z0-9._/*-]+$/;

function checkWord(value: unknown, label: string): string | null {
  if (!isNonEmptyString(value)) return `${label} must be a non-empty string`;
  if (utf8Bytes(value) > MAX_STRING_BYTES) return `${label} exceeds ${MAX_STRING_BYTES} bytes`;
  if (!LITERAL_WORD_RE.test(value)) return `${label} has characters the grammar does not allow`;
  return null;
}

function checkFlag(value: unknown): string | null {
  if (!isNonEmptyString(value)) return "flag must be a non-empty string";
  if (utf8Bytes(value) > MAX_STRING_BYTES) return `flag exceeds ${MAX_STRING_BYTES} bytes`;
  if (!LONG_FLAG_RE.test(value) && !SHORT_FLAG_RE.test(value)) return `flag "${value}" is not -x or --name[=value]`;
  return null;
}

/**
 * Compile a path glob: split into segments, validate the character set, reject
 * a `**` that is not a whole segment, and require at least one literal
 * non-root segment. Returns null when the pattern is rejected.
 */
export function compilePathGlob(pattern: string): string[] | null {
  if (!isNonEmptyString(pattern) || utf8Bytes(pattern) > MAX_STRING_BYTES) return null;
  if (pattern.startsWith("/") || pattern.endsWith("/")) return null;
  if (!PATH_GLOB_RE.test(pattern)) return null;
  const segments = pattern.split("/");
  if (segments.some((s) => s === "")) return null;
  let hasLiteral = false;
  for (const segment of segments) {
    if (segment === "**") continue;
    if (segment.includes("**")) return null; // `**` only as a whole segment
    if (segment === "." || segment === "..") return null;
    if (!segment.includes("*") && LITERAL_WORD_RE.test(segment)) hasLiteral = true;
  }
  return hasLiteral ? segments : null; // require a literal non-root segment
}

function checkPathGlob(value: unknown): string | null {
  if (!isNonEmptyString(value)) return "path must be a non-empty string";
  if (utf8Bytes(value) > MAX_STRING_BYTES) return `path exceeds ${MAX_STRING_BYTES} bytes`;
  if (compilePathGlob(value) === null) return `path glob "${value}" is rejected by the grammar`;
  return null;
}

/** Validate one trigger object. */
export function validateTrigger(raw: unknown): { ok: true; trigger: ActionTrigger } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "trigger is not an object" };
  const t = raw as Record<string, unknown>;
  if (!isNonEmptyString(t.verb) || !VERB_RE.test(t.verb)) return { ok: false, reason: "verb is not a literal executable basename" };
  if (utf8Bytes(t.verb) > MAX_STRING_BYTES) return { ok: false, reason: "verb exceeds the byte cap" };
  const subcommands = t.subcommands ?? [];
  const flags = t.flags ?? [];
  const paths = t.paths ?? [];
  if (!Array.isArray(subcommands) || !Array.isArray(flags) || !Array.isArray(paths)) {
    return { ok: false, reason: "subcommands/flags/paths must be arrays" };
  }
  if (subcommands.length > MAX_SUBCOMMANDS) return { ok: false, reason: `more than ${MAX_SUBCOMMANDS} subcommands` };
  if (flags.length > MAX_FLAGS) return { ok: false, reason: `more than ${MAX_FLAGS} flags` };
  if (paths.length > MAX_PATHS) return { ok: false, reason: `more than ${MAX_PATHS} paths` };
  for (let i = 0; i < subcommands.length; i++) {
    const err = checkWord(subcommands[i], `subcommand ${i}`);
    if (err) return { ok: false, reason: err };
  }
  for (let i = 0; i < flags.length; i++) {
    const err = checkFlag(flags[i]);
    if (err) return { ok: false, reason: err };
  }
  for (let i = 0; i < paths.length; i++) {
    const err = checkPathGlob(paths[i]);
    if (err) return { ok: false, reason: err };
  }
  // Reject bare-verb triggers: require a subcommand, flag or specific path.
  if (subcommands.length === 0 && flags.length === 0 && paths.length === 0) {
    return { ok: false, reason: "bare-verb trigger (no subcommand, flag or path)" };
  }
  return {
    ok: true,
    trigger: {
      verb: t.verb,
      subcommands: subcommands as string[],
      flags: flags as string[],
      paths: paths as string[],
    },
  };
}

/** Validate a lesson's complete trigger set (the array under `triggers`). */
export function validateTriggers(raw: unknown): TriggerResult {
  if (raw === undefined) return { ok: true, triggers: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "triggers is not an array" };
  if (raw.length > MAX_TRIGGERS_PER_LESSON) return { ok: false, reason: `more than ${MAX_TRIGGERS_PER_LESSON} triggers` };
  const out: ActionTrigger[] = [];
  for (const item of raw) {
    const result = validateTrigger(item);
    if (!result.ok) return { ok: false, reason: result.reason };
    out.push(result.trigger);
  }
  return { ok: true, triggers: out };
}

/**
 * Read `metadata.flairActionRecall` from a Memory row's JSON-string metadata.
 * Absent → `{ok:false, reason:"absent"}` (no triggers, not an error). A
 * present-but-invalid version/shape → `{ok:false, reason:"invalid"}` (the row
 * is ineligible). Omitted `triggers` means no triggers; `[]` disables recall.
 */
export function readTriggerMetadata(metadata: string | null | undefined): TriggerResult {
  if (!isNonEmptyString(metadata)) return { ok: false, reason: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "invalid" };
  const blob = (parsed as Record<string, unknown>)[METADATA_KEY];
  if (blob === undefined) return { ok: false, reason: "absent" };
  if (typeof blob !== "object" || blob === null || Array.isArray(blob)) return { ok: false, reason: "invalid" };
  const b = blob as Record<string, unknown>;
  if (b.v !== CACHE_VERSION) return { ok: false, reason: "invalid" };
  if (b.triggers === undefined) return { ok: true, triggers: [] };
  const result = validateTriggers(b.triggers);
  if (!result.ok) return { ok: false, reason: "invalid" };
  return result;
}

// ── restricted Bash reader ────────────────────────────────────────────────────

/** Characters that mean a shell expansion, substitution, list or command we
 *  will not interpret. Their presence anywhere unquoted is a rejection. */
const REJECT_UNQUOTED = new Set(["|", "&", ";", "<", ">", "(", ")", "`", "$", "#", "*", "?", "[", "]", "{", "}", "!", "~", "\n", "\r"]);
/** Verbs that wrap another command rather than being one. */
const WRAPPER_VERBS = new Set([
  "env", "command", "exec", "sudo", "doas", "nohup", "time", "xargs", "nice", "ionice", "setsid", "stdbuf", "watch",
]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Read ONE simple argv command: whitespace-separated tokens, literal single
 * and double quoting, and backslash escapes. Rejects expansions,
 * substitutions, assignments/wrappers, redirects, comments, pipelines, lists,
 * heredocs and compound commands. Never executes anything.
 */
export function parseSimpleBashCommand(command: string): BashParse {
  if (typeof command !== "string" || command.trim() === "") return { ok: false, reason: "empty" };
  if (utf8Bytes(command) > COMMAND_MAX_BYTES) return { ok: false, reason: "command too large" };
  const tokens: string[] = [];
  let buf = "";
  let started = false;
  let inSingle = false;
  let inDouble = false;
  const push = (): void => {
    if (started) tokens.push(buf);
    buf = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else buf += ch;
      started = true;
      continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined) return { ok: false, reason: "trailing backslash" };
      if (inDouble && !["$", "`", '"', "\\", "\n"].includes(next)) {
        buf += ch;
        started = true;
        continue;
      }
      if (next !== "\n") buf += next;
      started = true;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "$" || ch === "`") return { ok: false, reason: "expansion" };
      else if (ch === "\n") return { ok: false, reason: "newline" };
      else buf += ch;
      started = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    if (REJECT_UNQUOTED.has(ch)) return { ok: false, reason: "unsupported syntax" };
    buf += ch;
    started = true;
  }
  if (inSingle || inDouble) return { ok: false, reason: "unterminated quote" };
  push();
  if (tokens.length === 0) return { ok: false, reason: "empty" };
  if (tokens.length > MAX_ARGV_TOKENS) return { ok: false, reason: "too many tokens" };
  if (ASSIGNMENT_RE.test(tokens[0])) return { ok: false, reason: "assignment" };
  return { ok: true, argv: tokens };
}

/** Split a token into its short-flag cluster expansion (`-rf` → `-r`, `-f`). */
function expandShortCluster(token: string): string[] {
  const out: string[] = [];
  for (let i = 1; i < token.length; i++) out.push(`-${token[i]}`);
  return out;
}

/**
 * Parse a Bash command into the matching surface: verb (basename of argv[0]),
 * the raw subcommand prefix, the expanded flag set, and the operand tokens.
 * Returns null when the command is not one simple argv command.
 */
export function parseCommand(command: string): ParsedCommand | null {
  const parsed = parseSimpleBashCommand(command);
  if (!parsed.ok) return null;
  const argv = parsed.argv;
  const verb = commandBasename(argv[0]);
  if (WRAPPER_VERBS.has(verb)) return null;
  const flags = new Set<string>();
  const operands: string[] = [];
  const subcommands: string[] = [];
  let sawFlag = false;
  let optionsEnded = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      sawFlag = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--")) {
      flags.add(token);
      sawFlag = true;
      continue;
    }
    if (!optionsEnded && token.length > 1 && token.startsWith("-")) {
      for (const f of expandShortCluster(token)) flags.add(f);
      sawFlag = true;
      continue;
    }
    if (!sawFlag && subcommands.length < MAX_SUBCOMMANDS) subcommands.push(token);
    operands.push(token);
  }
  return { verb, argv, subcommands, flags, operands };
}

// ── path matching ─────────────────────────────────────────────────────────────

/**
 * Normalize an operand to a cwd-relative path, lexically, with no filesystem
 * reads. An absolute operand must lie beneath `cwd`; a relative operand must
 * not escape it. Returns null when it does not.
 */
export function normalizeOperand(operand: string, cwd: string): string | null {
  if (!isNonEmptyString(operand) || operand.includes("\0")) return null;
  const absolute = (p: string): string[] | null => {
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length === 0) return null;
        out.pop();
      } else out.push(seg);
    }
    return out;
  };
  const cwdSegs = absolute(cwd);
  if (cwdSegs === null) return null;
  if (operand.startsWith("/")) {
    const segs = absolute(operand);
    if (segs === null) return null;
    if (segs.length < cwdSegs.length || cwdSegs.some((s, i) => segs[i] !== s)) return null;
    return segs.slice(cwdSegs.length).join("/");
  }
  const segs = absolute(operand);
  if (segs === null) return null;
  return segs.join("/");
}

/** Match one path segment against a pattern segment containing `*` wildcards. */
function segmentMatches(pattern: string, value: string): boolean {
  const p = pattern.split("*");
  if (p.length === 1) return pattern === value;
  let pos = 0;
  if (!value.startsWith(p[0])) return false;
  pos = p[0].length;
  for (let i = 1; i < p.length - 1; i++) {
    const part = p[i];
    if (part === "") continue;
    const idx = value.indexOf(part, pos);
    if (idx === -1) return false;
    pos = idx + part.length;
  }
  const last = p[p.length - 1];
  if (last === "") return true;
  if (!value.endsWith(last)) return false;
  return value.length - last.length >= pos;
}

/** Anchored, case-sensitive whole-path match of a compiled glob. */
export function globMatchesPath(segments: string[], path: string): boolean {
  const parts = path === "" ? [] : path.split("/");
  const memo = new Map<string, boolean>();
  const walk = (si: number, pi: number): boolean => {
    const key = `${si}:${pi}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (si === segments.length) result = pi === parts.length;
    else if (segments[si] === "**") result = walk(si + 1, pi) || (pi < parts.length && walk(si, pi + 1));
    else result = pi < parts.length && segmentMatches(segments[si], parts[pi]) && walk(si + 1, pi + 1);
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/** Does `trigger` match the parsed `cmd`? All populated fields must match. */
export function triggerMatches(trigger: ActionTrigger, cmd: ParsedCommand, cwd: string): boolean {
  if (trigger.verb !== cmd.verb) return false;
  if (trigger.subcommands.length > 0) {
    if (cmd.argv.length < 1 + trigger.subcommands.length) return false;
    for (let i = 0; i < trigger.subcommands.length; i++) {
      if (cmd.argv[1 + i] !== trigger.subcommands[i]) return false;
    }
  }
  for (const flag of trigger.flags) {
    if (!cmd.flags.has(flag)) return false;
  }
  if (trigger.paths.length > 0) {
    const globs = trigger.paths.map((p) => compilePathGlob(p)).filter((g): g is string[] => g !== null);
    let matched = false;
    for (const operand of cmd.operands) {
      const rel = normalizeOperand(operand, cwd);
      if (rel === null) continue;
      if (globs.some((g) => globMatchesPath(g, rel))) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

// ── cache envelope and binding ─────────────────────────────────────────────────

/** Encode a payload as the `{payload, sha256}` envelope (JSON text). */
export function encodeEnvelope(payload: CachePayload): string {
  const json = JSON.stringify(payload);
  return JSON.stringify({ payload: json, sha256: sha256Hex(json) } satisfies CacheEnvelope);
}

function isValidTriggerShape(raw: unknown): raw is ActionTrigger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const t = raw as Record<string, unknown>;
  return (
    typeof t.verb === "string" &&
    Array.isArray(t.subcommands) &&
    t.subcommands.every((s) => typeof s === "string") &&
    Array.isArray(t.flags) &&
    t.flags.every((s) => typeof s === "string") &&
    Array.isArray(t.paths) &&
    t.paths.every((s) => typeof s === "string")
  );
}

function isValidEntry(raw: unknown): raw is CacheEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.owner === "string" &&
    typeof e.excerpt === "string" &&
    Array.isArray(e.triggers) &&
    e.triggers.every(isValidTriggerShape) &&
    (e.safetyFlags === undefined || (Array.isArray(e.safetyFlags) && e.safetyFlags.every((f) => typeof f === "string")))
  );
}

function isValidPayload(raw: unknown): raw is CachePayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const p = raw as Record<string, unknown>;
  return (
    p.v === CACHE_VERSION &&
    typeof p.url === "string" &&
    typeof p.principal === "string" &&
    typeof p.session === "string" &&
    typeof p.instance === "string" &&
    typeof p.generation === "string" &&
    typeof p.refreshStart === "number" &&
    Number.isFinite(p.refreshStart) &&
    typeof p.expiry === "number" &&
    Number.isFinite(p.expiry) &&
    Array.isArray(p.entries) &&
    p.entries.length <= CACHE_MAX_ENTRIES &&
    p.entries.every(isValidEntry)
  );
}

/**
 * Decode and validate an envelope. The digest must match the payload bytes and
 * the payload must satisfy the schema; oversized text is refused. Returns null
 * on any failure (missing/corrupt → silence on the read side).
 */
export function decodeEnvelope(text: string): CachePayload | null {
  if (typeof text !== "string" || utf8Bytes(text) > CACHE_MAX_BYTES) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return null;
  const env = envelope as Record<string, unknown>;
  if (typeof env.payload !== "string" || typeof env.sha256 !== "string") return null;
  if (sha256Hex(env.payload) !== env.sha256) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(env.payload);
  } catch {
    return null;
  }
  return isValidPayload(payload) ? payload : null;
}

function isValidBindingShape(raw: unknown): raw is CacheBinding {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const b = raw as Record<string, unknown>;
  return (
    b.v === CACHE_VERSION &&
    typeof b.url === "string" &&
    typeof b.principal === "string" &&
    typeof b.session === "string" &&
    typeof b.instance === "string" &&
    typeof b.generation === "string"
  );
}

/** Decode a binding file; null on any failure or if it exceeds BINDING_MAX_BYTES. */
export function decodeBinding(text: string): CacheBinding | null {
  if (typeof text !== "string" || utf8Bytes(text) > BINDING_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return isValidBindingShape(raw) ? raw : null;
}

/** Encode a binding file. */
export function encodeBinding(binding: CacheBinding): string {
  return JSON.stringify(binding);
}

/**
 * The generation's effective expiry: 5 minutes from refresh start, shortened by
 * each entry's own expiry/validity. A cache is stale when `now` is past this.
 */
export function effectiveExpiry(payload: CachePayload): number {
  let expiry = Math.min(payload.expiry, payload.refreshStart + STALE_MS);
  for (const entry of payload.entries) {
    for (const stamp of [entry.expiresAt, entry.validTo]) {
      if (typeof stamp !== "string") continue;
      const t = Date.parse(stamp);
      if (Number.isFinite(t) && t < expiry) expiry = t;
    }
  }
  return expiry;
}

/** True when the payload's bindings match the expected runtime values. */
export function bindingsMatch(
  payload: CachePayload,
  expected: { url: string; principal: string; session: string; instance: string; generation: string },
): boolean {
  return (
    payload.url === expected.url &&
    payload.principal === expected.principal &&
    payload.session === expected.session &&
    payload.instance === expected.instance &&
    payload.generation === expected.generation
  );
}

// ── selection and rendering ────────────────────────────────────────────────────

/** True when an entry's own validity/expiry has passed. */
function entryExpired(entry: CacheEntry, now: number): boolean {
  for (const stamp of [entry.expiresAt, entry.validTo]) {
    if (typeof stamp !== "string") continue;
    const t = Date.parse(stamp);
    if (Number.isFinite(t) && t <= now) return true;
  }
  return false;
}

/**
 * The entries that match this command: eligibility, safety, trigger match,
 * ID de-duplication, newest-first. `entries` arrive newest-first per the
 * refresh; ties fall back to ID.
 */
export function selectEntries(
  entries: readonly CacheEntry[],
  cmd: ParsedCommand,
  cwd: string,
  now: number,
): CacheEntry[] {
  const seen = new Set<string>();
  const out: CacheEntry[] = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id === "") continue;
    if (Array.isArray(entry.safetyFlags) && entry.safetyFlags.length > 0) continue;
    if (entryExpired(entry, now)) continue;
    if (!entry.triggers.some((trigger) => triggerMatches(trigger, cmd, cwd))) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/** One rendered hit: a header plus the excerpt as quoted lines. */
function renderHit(entry: CacheEntry): string {
  const lines: string[] = [];
  const created = typeof entry.createdAt === "string" ? entry.createdAt : "unknown";
  lines.push(`${QUOTE_PREFIX}id: ${entry.id} (created ${created})`);
  if (entry.provenance) lines.push(`${QUOTE_PREFIX}provenance: ${entry.provenance}`);
  for (const line of entry.excerpt.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)) {
    lines.push(`${QUOTE_PREFIX}${line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}`);
  }
  return redactSecrets(lines.join("\n"));
}

/**
 * Render the hits into the additionalContext string. Each hit is bounded to
 * HIT_MAX_BYTES (the excerpt is cut if needed) and the total to
 * STDOUT_MAX_BYTES minus the envelope overhead. Returns "" when there is
 * nothing to show.
 */
export function renderContext(entries: readonly CacheEntry[]): string {
  if (entries.length === 0) return "";
  const totalBudget = STDOUT_MAX_BYTES - 128; // room for the JSON envelope
  const parts: string[] = [RECALL_HEADER];
  for (const entry of entries) {
    let block = renderHit(entry);
    if (utf8Bytes(block) > HIT_MAX_BYTES) {
      // Trim the excerpt by cutting the whole block and re-closing it at a line.
      block = cutToUtf8Bytes(block, HIT_MAX_BYTES);
      const nl = block.lastIndexOf("\n");
      if (nl > 0) block = block.slice(0, nl);
    }
    const candidate = [...parts, block].join("\n");
    if (utf8Bytes(candidate) > totalBudget) break;
    parts.push(block);
  }
  return parts.length > 1 ? parts.join("\n") : "";
}

/** The exact PreToolUse hook output for a context string. */
export function hookOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } });
}

/** Redact and bound one lesson's text into a cacheable excerpt. */
export function buildExcerpt(content: string): string {
  return cutToUtf8Bytes(redactSecrets(content).replace(/\s+/g, " ").trim(), EXCERPT_MAX_BYTES);
}

/** Redact a provenance/short label. */
export function redactLabel(value: string): string {
  return cutToUtf8Bytes(redactSecrets(value).replace(/\s+/g, " ").trim(), MAX_STRING_BYTES);
}

export { REDACTED };
