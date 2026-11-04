/**
 * integrity-state.ts — evidence custody and the commit fence for the
 * integrity watcher (flair#971, slice 1a foundation).
 *
 * NOT REACHABLE YET. This module adds no command, resource or route. It is the
 * library half the enrollment and check slices build on:
 *
 *   - a v3 checkpoint whose ENTIRE record is HMAC-SHA256 over a canonical JSON
 *     encoding with a custody key;
 *   - the fixed twelve-reason taxonomy (strings, not prose) for callers to
 *     report;
 *   - the custody predicate: key directory 0700, key and state files 0600, no
 *     symlinks, no ACL grants, a server uid that can neither read the key nor
 *     write state, and the recorded operator uid and machine identity rechecked
 *     on every operation;
 *   - an authenticated enrollment registry with a monotonic sequence and
 *     tombstones, plus retained generations;
 *   - generation staging and uncertain-commit recovery on top of
 *     `withConfigCriticalSection` (NO second lock).
 *
 * The custody key and state live in the caller-supplied custody directory.
 * Modes alone cannot prove a server cannot reach them, so `checkCustody`
 * records and rechecks the operator/machine pair on every call and refuses a
 * same-machine same-uid arrangement; a test must additionally demonstrate the
 * real denial.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  assertSupportedLocalFilesystem,
  withConfigCriticalSection,
  writeAllSync,
  type ConfigSectionOptions,
  type ConfigSectionResult,
} from "./config-critical-section.js";
import { ALL_TIERS, type Tier } from "./memory-integrity.js";

export const INTEGRITY_STATE_VERSION = 3 as const;
export const INTEGRITY_KEY_FILENAME = "custody.key";
export const INTEGRITY_REGISTRY_FILENAME = "registry.json";
export const INTEGRITY_CURRENT_FILENAME = "CURRENT";
export const INTEGRITY_GENERATIONS_DIRNAME = "generations";
export const INTEGRITY_UNCERTAIN_FILENAME = "UNCERTAIN";

/**
 * The fixed reason union. These strings are part of the module contract: the
 * remaining slice-1 PRs report these values verbatim, so do not reword them.
 */
export const INTEGRITY_REASONS = [
  "uninitialized",
  "checkpoint_incompatible",
  "checkpoint_missing",
  "tampered",
  "unavailable",
  "wrong_target",
  "custody_invalid",
  "clock_invalid",
  "scan_failed",
  "store_over_ceiling",
  "commit_conflict",
  "commit_uncertain",
] as const;
export type IntegrityReason = (typeof INTEGRITY_REASONS)[number];

/** The remedy paired with each reason. Kept here so a caller cannot invent a
 *  reason without the operator-facing action. */
export const INTEGRITY_REASON_REMEDIES: Record<IntegrityReason, string> = {
  uninitialized: "Enroll this watch explicitly.",
  checkpoint_incompatible: "Enroll explicitly with compatible software; archive the legacy state.",
  checkpoint_missing: "Investigate; restore trusted evidence or accept after reconciliation.",
  tampered: "Investigate; restore trusted evidence or accept after reconciliation.",
  unavailable: "Restore access to the custody state and rerun.",
  wrong_target: "Restore the enrolled endpoint and instance identity.",
  custody_invalid: "Restore independent custody and the recorded operator/machine identity.",
  clock_invalid: "Repair the server clock or transport and rerun.",
  scan_failed: "Resolve the read failure and rerun.",
  store_over_ceiling: "Resolve store capacity or raise the configured ceiling, then rerun.",
  commit_conflict: "Resolve the competing writer and rerun.",
  commit_uncertain: "Recover the durable generation before another operation, then rerun.",
};

// ── record shapes ───────────────────────────────────────────────────────────

export interface IntegrityBaselineV3 {
  /** Server scan-start, aliased as the comparison baseline time. */
  scannedAt: string;
  scanStartedAt: string;
  scanEndedAt: string;
  /** Where the timestamps came from; slice 2 supplies the guarded endpoint. */
  clockSource: string;
  byDurability: Record<Tier, number>;
  ids: Record<string, string>;
  instanceTokens: Record<string, string | null>;
}

export interface IntegrityJournalEntry {
  at: string;
  kind: string;
  detail?: string;
}

/** A v3 checkpoint. The HMAC covers every field except `hmac` itself. */
export interface IntegrityCheckpointV3 {
  version: 3;
  kind: "checkpoint";
  enrollmentId: string;
  generation: number;
  operatorUid: number;
  machineId: string;
  baseline: IntegrityBaselineV3;
  /** Reserved for the comparison slice; retained with the generation. */
  journal?: IntegrityJournalEntry[];
  /** Reserved for slice 3a's outbox; retained with the generation. */
  pendingEvents?: unknown[];
  hmac: string;
}

export type IntegrityCheckpointPayload = Omit<IntegrityCheckpointV3, "hmac">;

export interface IntegrityCurrentPointer {
  version: 3;
  kind: "current";
  enrollmentId: string;
  generation: number;
  hmac: string;
}

export type IntegrityEnrollmentStatus = "active" | "tombstoned";

export interface IntegrityEnrollmentEntry {
  enrollmentId: string;
  sequence: number;
  createdAt: string;
  operatorUid: number;
  machineId: string;
  status: IntegrityEnrollmentStatus;
  tombstonedAt?: string;
}

/** The authenticated registry. `sequence` is monotonic across enrollment and
 *  tombstone operations; retained generation files are the generation history. */
export interface IntegrityRegistry {
  version: 3;
  kind: "registry";
  sequence: number;
  entries: IntegrityEnrollmentEntry[];
  hmac: string;
}

// ── canonical JSON + HMAC ───────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted, `undefined` omitted, arrays in
 *  order. HMACs are computed over THIS encoding, never over parse order. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function hmacHex(payload: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(`flair-integrity-v3\n${canonicalJson(payload)}`).digest("hex");
}

/** Sign a record: returns the same fields plus `hmac`. */
export function signIntegrityRecord<T extends Record<string, unknown>>(record: T, key: Buffer): T & { hmac: string } {
  const { hmac: _ignored, ...payload } = record as Record<string, unknown>;
  return { ...(payload as T), hmac: hmacHex(payload, key) } as T & { hmac: string };
}

function hmacMatches(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(actualHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verify a signed record's HMAC. A malformed hex digest is a mismatch, never
 *  a pass. */
export function verifyIntegrityRecord(record: unknown, key: Buffer): boolean {
  if (typeof record !== "object" || record === null || typeof (record as { hmac?: unknown }).hmac !== "string") return false;
  const { hmac, ...payload } = record as Record<string, unknown>;
  return hmacMatches(hmacHex(payload, key), hmac as string);
}

// ── paths ───────────────────────────────────────────────────────────────────

export interface IntegrityPaths {
  custodyDir: string;
  keyPath: string;
  registryPath: string;
  currentPath: string;
  generationsDir: string;
  uncertainPath: string;
}

export function integrityPaths(custodyDir: string): IntegrityPaths {
  return {
    custodyDir,
    keyPath: join(custodyDir, INTEGRITY_KEY_FILENAME),
    registryPath: join(custodyDir, INTEGRITY_REGISTRY_FILENAME),
    currentPath: join(custodyDir, INTEGRITY_CURRENT_FILENAME),
    generationsDir: join(custodyDir, INTEGRITY_GENERATIONS_DIRNAME),
    uncertainPath: join(custodyDir, INTEGRITY_UNCERTAIN_FILENAME),
  };
}

export function generationPath(generationsDir: string, generation: number): string {
  return join(generationsDir, `${String(generation).padStart(12, "0")}.json`);
}

// ── custody ─────────────────────────────────────────────────────────────────

export interface CustodyCheckOptions {
  paths: IntegrityPaths;
  serverUid: number;
  operatorUid: number;
  machineId: string;
  /** Values recorded at enrollment; when present they must match today's. */
  expectedOperatorUid?: number;
  expectedMachineId?: string;
  /** Skip key/registry existence checks while initializing. */
  requireFiles?: boolean;
  /** Check every retained generation file for ACLs too. */
  checkGenerations?: boolean;
}

export type CustodyCheck =
  | { ok: true }
  | { ok: false; reason: IntegrityReason; detail: string };

function modeOf(st: Stats): number {
  return st.mode & 0o7777;
}

function isPlainDir(st: Stats): boolean {
  return st.isDirectory() && !st.isSymbolicLink();
}

function isPlainFile(st: Stats): boolean {
  return st.isFile() && !st.isSymbolicLink();
}

/** Refuse a path that has any POSIX ACL entry beyond the base mode. `ls -l`
 *  appends `+` to the mode when an access ACL (or default ACL) is present; on
 *  macOS `-e` prints the entries. A probe that cannot answer refuses. */
function hasAcl(path: string): { ok: true } | { ok: false; detail: string } {
  try {
    const long = execFileSync("ls", ["-ld", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const mode = long.trim().split(/\s+/)[0] ?? "";
    if (mode.includes("+")) return { ok: false, detail: `an ACL is present on ${path}` };
    if (process.platform === "darwin") {
      const entries = execFileSync("ls", ["-lde", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (/^\s*\d+:\s/m.test(entries)) return { ok: false, detail: `an ACL entry is present on ${path}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `cannot inspect ACLs on ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkManagedEntry(
  path: string,
  kind: "dir" | "file",
  operatorUid: number,
): CustodyCheck {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason: IntegrityReason = code === "ENOENT" ? "checkpoint_missing" : "unavailable";
    return { ok: false, reason, detail: `cannot stat ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "custody_invalid", detail: `${path} is a symlink` };
  if (kind === "dir" ? !isPlainDir(st) : !isPlainFile(st)) {
    return { ok: false, reason: "custody_invalid", detail: `${path} is not a plain ${kind}` };
  }
  const wantMode = kind === "dir" ? 0o700 : 0o600;
  if (modeOf(st) !== wantMode) {
    return { ok: false, reason: "custody_invalid", detail: `${path} mode is ${modeOf(st).toString(8)}, expected ${wantMode.toString(8)}` };
  }
  if (st.uid !== operatorUid) {
    return { ok: false, reason: "custody_invalid", detail: `${path} is owned by uid ${st.uid}, not the operator uid ${operatorUid}` };
  }
  const acl = hasAcl(path);
  return acl.ok ? { ok: true } : { ok: false, reason: "custody_invalid", detail: acl.detail };
}

/** Whether a POSIX uid can read the key (mode 0600) or write inside the state
 *  directory (0700), ignoring ACLs (checked separately). Root can do both and
 *  is refused earlier. This is a static cross-check; the test suite also
 *  exercises the real syscall as another uid. */
function uidCanReadKeyOrWriteState(serverUid: number, operatorUid: number): boolean {
  if (serverUid === 0) return true;
  if (serverUid === operatorUid) return true;
  // Key is 0600 owned by the operator and the custody dir is 0700 owned by the
  // operator, so no other non-root uid has read or write bits.
  return false;
}

/** The custody predicate. Evaluated at enrollment and again at the start of
 *  every operation. All failures map to a reason from the fixed union. */
export function checkCustody(opts: CustodyCheckOptions): CustodyCheck {
  const { paths, serverUid, operatorUid, machineId } = opts;
  const requireFiles = opts.requireFiles ?? true;

  if (!Number.isSafeInteger(serverUid) || serverUid < 0) {
    return { ok: false, reason: "custody_invalid", detail: `server uid ${String(serverUid)} is not a valid uid` };
  }
  if (!Number.isSafeInteger(operatorUid) || operatorUid < 0) {
    return { ok: false, reason: "custody_invalid", detail: `operator uid ${String(operatorUid)} is not a valid uid` };
  }
  if (serverUid === operatorUid) {
    return { ok: false, reason: "custody_invalid", detail: "the server uid and the operator uid are the same on this machine; custody cannot separate them" };
  }
  if (uidCanReadKeyOrWriteState(serverUid, operatorUid)) {
    return { ok: false, reason: "custody_invalid", detail: `server uid ${serverUid} can read the key or write the state` };
  }
  if (opts.expectedOperatorUid !== undefined && opts.expectedOperatorUid !== operatorUid) {
    return { ok: false, reason: "custody_invalid", detail: `operator uid changed from the recorded ${opts.expectedOperatorUid} to ${operatorUid}` };
  }
  if (opts.expectedMachineId !== undefined && opts.expectedMachineId !== machineId) {
    return { ok: false, reason: "custody_invalid", detail: `machine identity changed from the recorded ${opts.expectedMachineId} to ${machineId}` };
  }

  const dir = checkManagedEntry(paths.custodyDir, "dir", operatorUid);
  if (!dir.ok) return dir;

  if (requireFiles) {
    const key = checkManagedEntry(paths.keyPath, "file", operatorUid);
    if (!key.ok) return key;
    const registry = checkManagedEntry(paths.registryPath, "file", operatorUid);
    if (!registry.ok) return registry;
    if (existsSync(paths.generationsDir)) {
      const gens = checkManagedEntry(paths.generationsDir, "dir", operatorUid);
      if (!gens.ok) return gens;
      if (opts.checkGenerations) {
        for (const name of listGenerationFiles(paths.generationsDir)) {
          const gen = checkManagedEntry(join(paths.generationsDir, name), "file", operatorUid);
          if (!gen.ok) return gen;
        }
      }
    }
    if (existsSync(paths.currentPath)) {
      const current = checkManagedEntry(paths.currentPath, "file", operatorUid);
      if (!current.ok) return current;
    }
  }
  return { ok: true };
}

/** Read the machine identity. The hostname is the stable part exposed by Node;
 *  a readable machine-id file adds the platform's stable id when present. A
 *  missing machine-id is not an error here (it is folded into the recorded
 *  value, and the value is rechecked later). */
export function machineIdentity(): string {
  let id = `${process.platform}:${hostname()}`;
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(candidate, "utf-8").trim();
      if (value.length > 0) {
        id = `${id}:${value}`;
        break;
      }
    } catch {
      // Absence is not an unknown for identity: the hostname still identifies
      // the machine we recorded and recheck.
    }
  }
  return id;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

// ── durable file helpers ────────────────────────────────────────────────────

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Create a new file durably (`wx`, explicit mode, full write, fsync). Never
 *  replaces an existing path. */
function writeNewDurable(path: string, bytes: Uint8Array, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeAllSync(fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  fsyncDir(dirname(path));
}

/** Replace an UNREFERENCED orphan generation atomically. A generation file is
 *  immutable once CURRENT names it; this is used only for a generation that a
 *  failed pre-rename commit staged while CURRENT still named its predecessor. */
function replaceDurable(path: string, bytes: Uint8Array, mode: number): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeAllSync(fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      fsyncSync(fd);
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    renameSync(temp, path);
    fsyncDir(dirname(path));
  } catch (err) {
    try { unlinkSync(temp); } catch { /* nothing to remove */ }
    throw err;
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf-8");
}

function listGenerationFiles(generationsDir: string): string[] {
  try {
    return readdirSync(generationsDir).filter((name) => /^\d{12}\.json$/.test(name)).sort();
  } catch {
    return [];
  }
}

function hasGenerationHistory(paths: IntegrityPaths): boolean {
  if (existsSync(paths.currentPath)) return true;
  return listGenerationFiles(paths.generationsDir).length > 0;
}

// ── registry ────────────────────────────────────────────────────────────────

type RegistryRead =
  | { kind: "absent" }
  | { kind: "ok"; registry: IntegrityRegistry }
  | { kind: "error"; reason: IntegrityReason; detail: string };

function validateRegistryShape(value: unknown): value is IntegrityRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.version !== 3 || r.kind !== "registry" || typeof r.hmac !== "string") return false;
  if (!Number.isSafeInteger(r.sequence) || (r.sequence as number) < 1) return false;
  if (!Array.isArray(r.entries)) return false;
  let maxSeq = 0;
  const ids = new Set<string>();
  for (const raw of r.entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.enrollmentId !== "string" || entry.enrollmentId.length === 0) return false;
    if (ids.has(entry.enrollmentId)) return false;
    ids.add(entry.enrollmentId);
    if (!Number.isSafeInteger(entry.sequence) || (entry.sequence as number) < 1) return false;
    maxSeq = Math.max(maxSeq, entry.sequence as number);
    if (typeof entry.createdAt !== "string") return false;
    if (!Number.isSafeInteger(entry.operatorUid)) return false;
    if (typeof entry.machineId !== "string" || entry.machineId.length === 0) return false;
    if (entry.status !== "active" && entry.status !== "tombstoned") return false;
    if (entry.status === "tombstoned" && typeof entry.tombstonedAt !== "string") return false;
  }
  return maxSeq <= (r.sequence as number);
}

function readRegistry(paths: IntegrityPaths, key: Buffer): RegistryRead {
  let raw: string;
  try {
    raw = readFileSync(paths.registryPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "error", reason: "unavailable", detail: `cannot read ${paths.registryPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "error", reason: "tampered", detail: `registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!validateRegistryShape(parsed)) {
    const version = (parsed as { version?: unknown } | null)?.version;
    return {
      kind: "error",
      reason: version !== undefined && version !== 3 ? "checkpoint_incompatible" : "tampered",
      detail: "registry is not a valid v3 integrity registry",
    };
  }
  if (!verifyIntegrityRecord(parsed, key)) {
    return { kind: "error", reason: "tampered", detail: "registry HMAC does not match" };
  }
  return { kind: "ok", registry: parsed };
}

function activeEntry(registry: IntegrityRegistry, enrollmentId: string): IntegrityEnrollmentEntry | null {
  return registry.entries.find((entry) => entry.enrollmentId === enrollmentId && entry.status === "active") ?? null;
}

// ── checkpoint / current records ────────────────────────────────────────────

function validateCheckpointShape(value: unknown): value is IntegrityCheckpointV3 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (c.version !== 3 || c.kind !== "checkpoint" || typeof c.hmac !== "string") return false;
  if (typeof c.enrollmentId !== "string" || c.enrollmentId.length === 0) return false;
  if (!Number.isSafeInteger(c.generation) || (c.generation as number) < 1) return false;
  if (!Number.isSafeInteger(c.operatorUid)) return false;
  if (typeof c.machineId !== "string" || c.machineId.length === 0) return false;
  if (typeof c.baseline !== "object" || c.baseline === null || Array.isArray(c.baseline)) return false;
  const b = c.baseline as Record<string, unknown>;
  if (typeof b.scannedAt !== "string" || typeof b.scanStartedAt !== "string" || typeof b.scanEndedAt !== "string") return false;
  if (typeof b.clockSource !== "string" || b.clockSource.length === 0) return false;
  if (typeof b.ids !== "object" || b.ids === null || Array.isArray(b.ids)) return false;
  if (!Object.entries(b.ids).every(([id, tier]) => id.length > 0 && (ALL_TIERS as readonly unknown[]).includes(tier))) return false;
  if (typeof b.instanceTokens !== "object" || b.instanceTokens === null || Array.isArray(b.instanceTokens)) return false;
  if (Object.keys(b.instanceTokens).length !== Object.keys(b.ids).length) return false;
  if (!Object.keys(b.ids).every((id) => Object.hasOwn(b.instanceTokens as object, id) &&
    ((b.instanceTokens as Record<string, unknown>)[id] === null || (typeof (b.instanceTokens as Record<string, unknown>)[id] === "string" && ((b.instanceTokens as Record<string, unknown>)[id] as string).length > 0)))) return false;
  if (typeof b.byDurability !== "object" || b.byDurability === null || Array.isArray(b.byDurability)) return false;
  if (!ALL_TIERS.every((tier) => Number.isSafeInteger((b.byDurability as Record<string, unknown>)[tier]) && ((b.byDurability as Record<string, unknown>)[tier] as number) >= 0)) return false;
  if (c.journal !== undefined && !Array.isArray(c.journal)) return false;
  if (c.pendingEvents !== undefined && !Array.isArray(c.pendingEvents)) return false;
  return true;
}

function validateCurrentShape(value: unknown): value is IntegrityCurrentPointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return c.version === 3 && c.kind === "current" &&
    typeof c.enrollmentId === "string" && c.enrollmentId.length > 0 &&
    Number.isSafeInteger(c.generation) && (c.generation as number) >= 1 &&
    typeof c.hmac === "string";
}

function readSignedJson<T>(
  path: string,
  validator: (value: unknown) => value is T,
  key: Buffer,
  label: string,
): { kind: "ok"; value: T } | { kind: "absent" } | { kind: "error"; reason: IntegrityReason; detail: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "error", reason: "unavailable", detail: `cannot read ${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "error", reason: "tampered", detail: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!validator(parsed)) {
    const version = (parsed as { version?: unknown } | null)?.version;
    return {
      kind: "error",
      reason: version !== undefined && version !== 3 ? "checkpoint_incompatible" : "tampered",
      detail: `${label} is not a valid v3 record`,
    };
  }
  if (!verifyIntegrityRecord(parsed, key)) {
    return { kind: "error", reason: "tampered", detail: `${label} HMAC does not match` };
  }
  return { kind: "ok", value: parsed };
}

// ── handle and results ──────────────────────────────────────────────────────

export interface IntegrityStateHandle {
  paths: IntegrityPaths;
  key: Buffer;
  registry: IntegrityRegistry;
  enrollment: IntegrityEnrollmentEntry;
  checkpoint: IntegrityCheckpointV3 | null;
  generation: number;
  operatorUid: number;
  machineId: string;
  serverUid: number;
  /** True when this open recovered an uncertain commit or a retained
   *  generation before returning. */
  recovered: boolean;
}

export type IntegrityStateResult =
  | { ok: true; state: IntegrityStateHandle }
  | { ok: false; reason: IntegrityReason; detail: string; remedy: string };

export type CommitStatus = "committed" | "commit_conflict" | "commit_uncertain" | "commit_failed";

export type CommitGenerationResult =
  | { ok: true; status: "committed"; generation: number; attempts: number }
  | {
      ok: false;
      status: Exclude<CommitStatus, "committed">;
      reason: IntegrityReason;
      detail: string;
      remedy: string;
      /** True when CURRENT was replaced even though the result is not success
       *  (a post-rename durability warning). */
      committed?: boolean;
      generation?: number;
    };

export interface IntegrityStateOptions {
  custodyDir: string;
  /** Instance data dir, used to derive the server uid when `serverUid` is not
   *  supplied. */
  dataDir?: string;
  serverUid?: number;
  operatorUid?: number;
  machineId?: string;
  enrollmentId?: string;
  newCustody?: boolean;
  /** Test seam only: check every retained generation file for ACLs. */
  checkGenerations?: boolean;
}

export interface CommitGenerationOptions {
  state: IntegrityStateHandle;
  /** Generation observed before the scan. A mismatch holds the write. */
  expectedGeneration: number;
  checkpoint: Omit<IntegrityCheckpointPayload, "version" | "kind" | "enrollmentId" | "generation" | "operatorUid" | "machineId">;
  /** TEST-ONLY barriers, from the shared critical section. */
  testHooks?: ConfigSectionOptions["testHooks"];
}

function fail(reason: IntegrityReason, detail: string): IntegrityStateResult {
  return { ok: false, reason, detail, remedy: INTEGRITY_REASON_REMEDIES[reason] };
}

function deriveServerUid(opts: IntegrityStateOptions, operatorUid: number): { ok: true; uid: number } | { ok: false; detail: string } {
  if (opts.serverUid !== undefined) return { ok: true, uid: opts.serverUid };
  if (opts.dataDir === undefined) {
    return { ok: false, detail: "no dataDir or serverUid was supplied; the server uid cannot be established" };
  }
  try {
    return { ok: true, uid: statSync(opts.dataDir).uid };
  } catch (err) {
    return { ok: false, detail: `cannot stat the data dir ${opts.dataDir}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function readKey(paths: IntegrityPaths): { ok: true; key: Buffer } | { ok: false; reason: IntegrityReason; detail: string } {
  let key: Buffer;
  try {
    key = readFileSync(paths.keyPath);
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: `cannot read the custody key: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (key.length !== 32) {
    return { ok: false, reason: "custody_invalid", detail: `the custody key is ${key.length} bytes, expected 32` };
  }
  return { ok: true, key };
}

function ensureLocalFilesystem(paths: IntegrityPaths): { ok: true } | { ok: false; reason: IntegrityReason; detail: string } {
  for (const target of [paths.custodyDir, paths.generationsDir]) {
    const fsCheck = assertSupportedLocalFilesystem(target);
    if (!fsCheck.ok) return { ok: false, reason: "custody_invalid", detail: fsCheck.reason };
  }
  return { ok: true };
}

// ── generation recovery ─────────────────────────────────────────────────────

function newestGeneration(paths: IntegrityPaths, key: Buffer, enrollmentId: string, operatorUid: number, machineId: string):
  { kind: "ok"; checkpoint: IntegrityCheckpointV3 } | { kind: "absent" } | { kind: "error"; reason: IntegrityReason; detail: string } {
  const files = listGenerationFiles(paths.generationsDir);
  for (let i = files.length - 1; i >= 0; i--) {
    const path = join(paths.generationsDir, files[i]!);
    const read = readSignedJson(path, validateCheckpointShape, key, `generation ${files[i]}`);
    if (read.kind === "error") return read;
    if (read.kind === "absent") continue;
    const cp = read.value;
    if (cp.enrollmentId !== enrollmentId) {
      return { kind: "error", reason: "custody_invalid", detail: `generation ${cp.generation} belongs to a different enrollment` };
    }
    if (cp.operatorUid !== operatorUid || cp.machineId !== machineId) {
      return { kind: "error", reason: "custody_invalid", detail: `generation ${cp.generation} records a different operator or machine` };
    }
    return { kind: "ok", checkpoint: cp };
  }
  return { kind: "absent" };
}

/** Restore CURRENT from the newest retained generation. Used only when CURRENT
 *  is absent (an interrupted or rolled-back pointer write), never to paper over
 *  an unreadable or tampered CURRENT. */
function restoreCurrentFromGeneration(
  paths: IntegrityPaths,
  key: Buffer,
  enrollmentId: string,
  checkpoint: IntegrityCheckpointV3,
): { ok: true } | { ok: false; reason: IntegrityReason; detail: string } {
  try {
    fsyncFile(generationPath(paths.generationsDir, checkpoint.generation));
    fsyncDir(paths.generationsDir);
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: `cannot fsync the retained generation: ${err instanceof Error ? err.message : String(err)}` };
  }
  const pointer = signIntegrityRecord({
    version: INTEGRITY_STATE_VERSION,
    kind: "current",
    enrollmentId,
    generation: checkpoint.generation,
  } satisfies Omit<IntegrityCurrentPointer, "hmac">, key);
  const result = withConfigCriticalSection(paths.currentPath, (bytes) => {
    if (bytes !== null && bytes.byteLength > 0) {
      return { hold: "commit_conflict: CURRENT appeared while restoring a retained generation" };
    }
    return { write: jsonBytes(pointer) };
  });
  if (result.status !== "written") {
    return { ok: false, reason: "unavailable", detail: `cannot restore CURRENT: ${result.message}` };
  }
  if (result.cleanupWarning) {
    return { ok: false, reason: "commit_uncertain", detail: result.cleanupWarning };
  }
  return { ok: true };
}

// ── initialization and open ─────────────────────────────────────────────────

function writeInitialRegistry(paths: IntegrityPaths, key: Buffer, operatorUid: number, machineId: string): IntegrityRegistry {
  const enrollmentId = `enr_${randomBytes(16).toString("hex")}`;
  const registry = signIntegrityRecord({
    version: INTEGRITY_STATE_VERSION,
    kind: "registry",
    sequence: 1,
    entries: [{
      enrollmentId,
      sequence: 1,
      createdAt: new Date().toISOString(),
      operatorUid,
      machineId,
      status: "active",
    }],
  } satisfies Omit<IntegrityRegistry, "hmac">, key);
  writeNewDurable(paths.registryPath, jsonBytes(registry), 0o600);
  return registry;
}

function openWithRegistry(
  paths: IntegrityPaths,
  key: Buffer,
  registry: IntegrityRegistry,
  opts: IntegrityStateOptions,
  operatorUid: number,
  machineId: string,
  serverUid: number,
  allowEmpty: boolean,
): IntegrityStateResult {
  const enrollmentId = opts.enrollmentId ?? registry.entries.find((entry) => entry.status === "active")?.enrollmentId;
  if (!enrollmentId) return fail("custody_invalid", "the registry has no active enrollment");
  const enrollment = activeEntry(registry, enrollmentId);
  if (!enrollment) return fail("custody_invalid", `enrollment ${enrollmentId} is not active`);
  if (enrollment.operatorUid !== operatorUid || enrollment.machineId !== machineId) {
    return fail("custody_invalid", "the recorded operator uid or machine identity changed");
  }

  const custody = checkCustody({
    paths,
    serverUid,
    operatorUid,
    machineId,
    expectedOperatorUid: enrollment.operatorUid,
    expectedMachineId: enrollment.machineId,
    checkGenerations: opts.checkGenerations ?? true,
  });
  if (!custody.ok) return fail(custody.reason, custody.detail);

  let recovered = false;
  const current = readSignedJson(paths.currentPath, validateCurrentShape, key, "CURRENT");
  if (current.kind === "error") return fail(current.reason, current.detail);

  let checkpoint: IntegrityCheckpointV3 | null = null;
  if (current.kind === "absent") {
    const newest = newestGeneration(paths, key, enrollmentId, operatorUid, machineId);
    if (newest.kind === "error") return fail(newest.reason, newest.detail);
    if (newest.kind === "absent") {
      if (!allowEmpty) return fail("checkpoint_missing", "no CURRENT pointer and no retained generation");
    } else {
      checkpoint = newest.checkpoint;
      const restored = restoreCurrentFromGeneration(paths, key, enrollmentId, checkpoint);
      if (!restored.ok) return fail(restored.reason, restored.detail);
      recovered = true;
    }
  } else {
    const pointer = current.value;
    if (pointer.enrollmentId !== enrollmentId) {
      return fail("custody_invalid", "CURRENT belongs to a different enrollment");
    }
    const genRead = readSignedJson(
      generationPath(paths.generationsDir, pointer.generation),
      validateCheckpointShape,
      key,
      `generation ${pointer.generation}`,
    );
    if (genRead.kind === "error") return fail(genRead.reason, genRead.detail);
    if (genRead.kind === "absent") return fail("tampered", `CURRENT points to missing generation ${pointer.generation}`);
    checkpoint = genRead.value;
    if (checkpoint.enrollmentId !== enrollmentId) {
      return fail("custody_invalid", "the current generation belongs to a different enrollment");
    }
    if (checkpoint.generation !== pointer.generation) {
      return fail("tampered", "CURRENT generation and generation record disagree");
    }
    if (checkpoint.operatorUid !== operatorUid || checkpoint.machineId !== machineId) {
      return fail("custody_invalid", "the current generation records a different operator or machine");
    }
  }

  // An UNCERTAIN marker means the last replacement committed but its directory
  // fsync did not complete. Verify and fsync the durable generation before any
  // operation, then clear the marker.
  if (checkpoint !== null) {
    let marked: string | null = null;
    try {
      marked = readFileSync(paths.uncertainPath, "utf-8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return fail("unavailable", `cannot read the uncertainty marker: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (marked !== null) {
      if (marked.length > 0 && Number(marked) !== checkpoint.generation) {
        return fail("commit_uncertain", `the uncertainty marker names generation ${marked}, current is ${checkpoint.generation}`);
      }
      try {
        fsyncFile(generationPath(paths.generationsDir, checkpoint.generation));
        fsyncDir(paths.generationsDir);
        fsyncDir(paths.custodyDir);
        unlinkSync(paths.uncertainPath);
      } catch (err) {
        return fail("commit_uncertain", `cannot recover the uncertain commit: ${err instanceof Error ? err.message : String(err)}`);
      }
      recovered = true;
    }
  }

  return {
    ok: true,
    state: {
      paths,
      key,
      registry,
      enrollment,
      checkpoint,
      generation: checkpoint?.generation ?? 0,
      operatorUid,
      machineId,
      serverUid,
      recovered,
    },
  };
}

/** Create custody for a genuine first use. `newCustody: true` is required: an
 *  absent registry with ANY generation history is `custody_invalid`, never
 *  `uninitialized` (N5), and an existing registry is not re-initialized. */
export function initializeIntegrityCustody(opts: IntegrityStateOptions): IntegrityStateResult {
  const uid = opts.operatorUid ?? currentUid();
  if (uid === null) return fail("custody_invalid", "the process has no uid; custody cannot be established");
  const machineId = opts.machineId ?? machineIdentity();
  const derived = deriveServerUid(opts, uid);
  if (!derived.ok) return fail("unavailable", derived.detail);
  if (derived.uid === uid || derived.uid === 0) {
    return fail("custody_invalid", "the server uid and the operator uid must differ, and the server must not be root");
  }

  const paths = integrityPaths(opts.custodyDir);
  const fsCheck = assertSupportedLocalFilesystem(paths.custodyDir);
  if (!fsCheck.ok) return fail("custody_invalid", fsCheck.reason);

  if (existsSync(paths.registryPath)) {
    const registryEntry = checkManagedEntry(paths.registryPath, "file", uid);
    if (!registryEntry.ok) return fail(registryEntry.reason, registryEntry.detail);
    if (existsSync(paths.keyPath)) {
      const keyEntry = checkManagedEntry(paths.keyPath, "file", uid);
      if (!keyEntry.ok) return fail(keyEntry.reason, keyEntry.detail);
    }
    const key = readKey(paths);
    if (!key.ok) return fail(key.reason, key.detail);
    const read = readRegistry(paths, key.key);
    if (read.kind === "absent") return fail("unavailable", "the registry disappeared during initialization");
    if (read.kind === "error") return fail(read.reason, read.detail);
    return fail("custody_invalid", "custody is already initialized; use the existing state");
  }
  if (hasGenerationHistory(paths)) {
    return fail("custody_invalid", "the registry is absent but generation history exists; refusing to mint a new custody root");
  }
  if (opts.newCustody !== true) {
    return fail("uninitialized", "first use requires an explicit new-custody flag");
  }

  try {
    mkdirSync(paths.custodyDir, { recursive: true, mode: 0o700 });
    const dirStat = statSync(paths.custodyDir);
    if (!dirStat.isDirectory() || (dirStat.mode & 0o777) !== 0o700) {
      return fail("custody_invalid", `the custody directory is not mode 0700`);
    }
    mkdirSync(paths.generationsDir, { recursive: true, mode: 0o700 });
    const genStat = statSync(paths.generationsDir);
    if (!genStat.isDirectory() || (genStat.mode & 0o777) !== 0o700) {
      return fail("custody_invalid", `the generations directory is not mode 0700`);
    }
    writeNewDurable(paths.keyPath, randomBytes(32), 0o600);
    fsyncDir(paths.custodyDir);
  } catch (err) {
    return fail("unavailable", `creating custody failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const key = readKey(paths);
  if (!key.ok) return fail(key.reason, key.detail);
  let registry: IntegrityRegistry;
  try {
    registry = writeInitialRegistry(paths, key.key, uid, machineId);
  } catch (err) {
    return fail("unavailable", `writing the registry failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const custody = checkCustody({
    paths,
    serverUid: derived.uid,
    operatorUid: uid,
    machineId,
    expectedOperatorUid: uid,
    expectedMachineId: machineId,
    checkGenerations: opts.checkGenerations ?? true,
  });
  if (!custody.ok) return fail(custody.reason, custody.detail);

  return openWithRegistry(paths, key.key, registry, opts, uid, machineId, derived.uid, true);
}

/** Open existing custody and recover an interrupted commit before returning.
 *  Custody is rechecked on EVERY call. */
export function openIntegrityState(opts: IntegrityStateOptions): IntegrityStateResult {
  const uid = opts.operatorUid ?? currentUid();
  if (uid === null) return fail("custody_invalid", "the process has no uid; custody cannot be verified");
  const machineId = opts.machineId ?? machineIdentity();
  const derived = deriveServerUid(opts, uid);
  if (!derived.ok) return fail("unavailable", derived.detail);
  if (derived.uid === uid || derived.uid === 0) {
    return fail("custody_invalid", "the server uid and the operator uid must differ, and the server must not be root");
  }

  const paths = integrityPaths(opts.custodyDir);
  const fsCheck = ensureLocalFilesystem(paths);
  if (!fsCheck.ok) return fail(fsCheck.reason, fsCheck.detail);

  // Refuse a symlinked or wrongly-moded managed file BEFORE reading it.
  for (const [managed, kind] of [[paths.keyPath, "file"], [paths.registryPath, "file"], [paths.currentPath, "file"]] as const) {
    if (existsSync(managed)) {
      const check = checkManagedEntry(managed, kind, uid);
      if (!check.ok) return fail(check.reason, check.detail);
    }
  }

  const key = readKey(paths);
  if (!key.ok) {
    if (key.reason === "unavailable" && !existsSync(paths.keyPath) && hasGenerationHistory(paths)) {
      return fail("custody_invalid", "the key is absent while generation history exists");
    }
    return fail(key.reason, key.detail);
  }

  const read = readRegistry(paths, key.key);
  if (read.kind === "absent") {
    if (hasGenerationHistory(paths)) {
      return fail("custody_invalid", "the registry is absent but generation history exists; refusing to treat this as first use");
    }
    return fail("uninitialized", "no custody registry exists; an explicit new-custody enrollment is required");
  }
  if (read.kind === "error") return fail(read.reason, read.detail);

  return openWithRegistry(paths, key.key, read.registry, opts, uid, machineId, derived.uid, false);
}

// ── commit ──────────────────────────────────────────────────────────────────

function checkpointPayloadFor(opts: CommitGenerationOptions, generation: number): IntegrityCheckpointPayload {
  const { state } = opts;
  return {
    version: INTEGRITY_STATE_VERSION,
    kind: "checkpoint",
    enrollmentId: state.enrollment.enrollmentId,
    generation,
    operatorUid: state.operatorUid,
    machineId: state.machineId,
    baseline: opts.checkpoint.baseline,
    ...(opts.checkpoint.journal !== undefined ? { journal: opts.checkpoint.journal } : {}),
    ...(opts.checkpoint.pendingEvents !== undefined ? { pendingEvents: opts.checkpoint.pendingEvents } : {}),
  };
}

function holdMessage(reason: IntegrityReason, detail: string): { hold: string } {
  return { hold: `${reason}: ${detail}` };
}

function parseHold(message: string): { reason: IntegrityReason; detail: string } {
  const [head, ...rest] = message.split(":");
  if ((INTEGRITY_REASONS as readonly string[]).includes(head!) && rest.length > 0) {
    return { reason: head as IntegrityReason, detail: rest.join(":").trim() };
  }
  return { reason: "commit_conflict", detail: message };
}

/**
 * Commit a generation under the shared critical section.
 *
 * The pre-scan generation is rechecked inside `decide`; a mismatch returns
 * `commit_conflict` and never writes. The generation file is staged under the
 * SAME lock (via the section's `stage` extension) before CURRENT is replaced.
 * A post-rename directory-fsync warning is `commit_uncertain`, never success.
 */
export function commitGeneration(opts: CommitGenerationOptions): CommitGenerationResult {
  const { state } = opts;
  if (!Number.isSafeInteger(opts.expectedGeneration) || opts.expectedGeneration < 0) {
    return { ok: false, status: "commit_failed", reason: "commit_conflict", detail: "the expected generation is not a non-negative integer", remedy: INTEGRITY_REASON_REMEDIES.commit_conflict };
  }

  // Custody is rechecked at the start of the commit operation too, not only
  // when the state was opened: a mode or identity drift between the open and
  // the commit must not stage a generation.
  const custody = checkCustody({
    paths: state.paths,
    serverUid: state.serverUid,
    operatorUid: state.operatorUid,
    machineId: state.machineId,
    expectedOperatorUid: state.enrollment.operatorUid,
    expectedMachineId: state.enrollment.machineId,
    checkGenerations: true,
  });
  if (!custody.ok) {
    return {
      ok: false,
      status: "commit_failed",
      reason: custody.reason,
      detail: custody.detail,
      remedy: INTEGRITY_REASON_REMEDIES[custody.reason],
    };
  }

  const nextGeneration = opts.expectedGeneration + 1;
  const checkpointPayload = checkpointPayloadFor(opts, nextGeneration);
  const checkpoint = signIntegrityRecord(checkpointPayload, state.key);
  const pointerPayload: Omit<IntegrityCurrentPointer, "hmac"> = {
    version: INTEGRITY_STATE_VERSION,
    kind: "current",
    enrollmentId: state.enrollment.enrollmentId,
    generation: nextGeneration,
  };
  const pointer = signIntegrityRecord(pointerPayload, state.key);
  const generationBytes = jsonBytes(checkpoint);
  let stagedGeneration: number | null = null;

  const decide = (bytes: Uint8Array | null): { write: Uint8Array } | { hold: string } => {
    // Recheck the registry under the lock: an enrollment tombstoned while this
    // scan ran must not publish a new generation.
    const registryRead = readRegistry(state.paths, state.key);
    if (registryRead.kind === "absent") return holdMessage("custody_invalid", "the registry vanished before commit");
    if (registryRead.kind === "error") return holdMessage(registryRead.reason, registryRead.detail);
    const entry = activeEntry(registryRead.registry, state.enrollment.enrollmentId);
    if (!entry) return holdMessage("custody_invalid", "the enrollment is no longer active");
    if (entry.sequence !== state.enrollment.sequence) {
      return holdMessage("custody_invalid", "the enrollment sequence changed during the scan");
    }

    let onDisk = 0;
    if (bytes !== null && bytes.byteLength > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
      } catch (err) {
        return holdMessage("tampered", `CURRENT is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!validateCurrentShape(parsed)) return holdMessage("tampered", "CURRENT is not a valid v3 pointer");
      if (!verifyIntegrityRecord(parsed, state.key)) return holdMessage("tampered", "CURRENT HMAC does not match");
      const pointerNow = parsed as IntegrityCurrentPointer;
      if (pointerNow.enrollmentId !== state.enrollment.enrollmentId) {
        return holdMessage("custody_invalid", "CURRENT belongs to a different enrollment");
      }
      onDisk = pointerNow.generation;
    }
    // The generation observed before the scan. This is the fence: a competing
    // writer that committed in between leaves a different value here.
    if (onDisk !== opts.expectedGeneration) {
      return holdMessage("commit_conflict", `the on-disk generation is ${onDisk}, expected ${opts.expectedGeneration}`);
    }
    stagedGeneration = nextGeneration;
    return { write: jsonBytes(pointer) };
  };

  const stage = (_bytes: Uint8Array): void => {
    const path = generationPath(state.paths.generationsDir, nextGeneration);
    try {
      writeNewDurable(path, generationBytes, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readFileSync(path);
      if (!Buffer.from(generationBytes).equals(existing)) {
        // CURRENT still names expectedGeneration (checked in decide), so this
        // generation is an unreferenced orphan from a failed pre-rename
        // attempt. Replace it; a referenced generation is never touched.
        replaceDurable(path, generationBytes, 0o600);
      }
    }
    stagedGeneration = nextGeneration;
  };

  let result: ConfigSectionResult;
  try {
    result = withConfigCriticalSection(state.paths.currentPath, decide, {
      stage,
      testHooks: opts.testHooks,
    });
  } catch (err) {
    return {
      ok: false,
      status: "commit_failed",
      reason: "unavailable",
      detail: `the commit fence failed before replacing CURRENT: ${err instanceof Error ? err.message : String(err)}`,
      remedy: INTEGRITY_REASON_REMEDIES.unavailable,
    };
  }

  if (result.status === "written") {
    if (result.cleanupWarning) {
      // CURRENT is committed, but its directory fsync did not complete. Mark
      // the generation uncertain so the next operation verifies and fsyncs it.
      try {
        writeFileSync(state.paths.uncertainPath, String(nextGeneration), { mode: 0o600 });
        fsyncFile(state.paths.uncertainPath);
        fsyncDir(state.paths.custodyDir);
      } catch {
        // The marker is best-effort; the commit is still reported uncertain.
      }
      return {
        ok: false,
        status: "commit_uncertain",
        reason: "commit_uncertain",
        detail: result.cleanupWarning,
        remedy: INTEGRITY_REASON_REMEDIES.commit_uncertain,
        committed: true,
        generation: nextGeneration,
      };
    }
    return { ok: true, status: "committed", generation: nextGeneration, attempts: result.attempts };
  }

  if (result.status === "held") {
    const parsed = parseHold(result.message);
    return {
      ok: false,
      status: "commit_conflict",
      reason: parsed.reason,
      detail: parsed.detail,
      remedy: INTEGRITY_REASON_REMEDIES[parsed.reason],
    };
  }

  // refused: the target was not replaced. A staged generation may remain, but
  // it is immutable and unreferenced; a retry with identical bytes accepts it.
  return {
    ok: false,
    status: "commit_failed",
    reason: "unavailable",
    detail: result.message,
    remedy: INTEGRITY_REASON_REMEDIES.unavailable,
  };
}

// ── registry tombstone ──────────────────────────────────────────────────────

export interface TombstoneOptions extends IntegrityStateOptions {
  expectedSequence: number;
}

export type TombstoneResult =
  | { ok: true; sequence: number }
  | { ok: false; status: "commit_conflict" | "commit_failed"; reason: IntegrityReason; detail: string; remedy: string };

/** Tombstone an enrollment under the same critical section. The sequence is a
 *  compare-and-swap: a stale expectation holds. No new lock is introduced. */
export function tombstoneEnrollment(opts: TombstoneOptions): TombstoneResult {
  const opened = openIntegrityState(opts);
  if (!opened.ok) return { ok: false, status: "commit_failed", reason: opened.reason, detail: opened.detail, remedy: opened.remedy };
  const state = opened.state;
  const enrollmentId = opts.enrollmentId ?? state.enrollment.enrollmentId;
  let nextSequence = 0;
  const decide = (bytes: Uint8Array | null): { write: Uint8Array } | { hold: string } => {
    if (bytes === null || bytes.byteLength === 0) return holdMessage("checkpoint_missing", "the registry is absent");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
    } catch (err) {
      return holdMessage("tampered", `registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!validateRegistryShape(parsed)) return holdMessage("tampered", "registry is not a valid v3 registry");
    if (!verifyIntegrityRecord(parsed, state.key)) return holdMessage("tampered", "registry HMAC does not match");
    const registry = parsed;
    if (registry.sequence !== opts.expectedSequence) {
      return holdMessage("commit_conflict", `the registry sequence is ${registry.sequence}, expected ${opts.expectedSequence}`);
    }
    const entry = registry.entries.find((candidate) => candidate.enrollmentId === enrollmentId);
    if (!entry) return holdMessage("custody_invalid", `enrollment ${enrollmentId} is not registered`);
    if (entry.status === "tombstoned") return holdMessage("custody_invalid", `enrollment ${enrollmentId} is already tombstoned`);
    nextSequence = registry.sequence + 1;
    const updated = signIntegrityRecord({
      version: INTEGRITY_STATE_VERSION,
      kind: "registry",
      sequence: nextSequence,
      entries: registry.entries.map((candidate) => candidate.enrollmentId === enrollmentId
        ? { ...candidate, status: "tombstoned" as const, tombstonedAt: new Date().toISOString() }
        : candidate),
    } satisfies Omit<IntegrityRegistry, "hmac">, state.key);
    return { write: jsonBytes(updated) };
  };
  const result = withConfigCriticalSection(state.paths.registryPath, decide);
  if (result.status === "written" && !result.cleanupWarning) return { ok: true, sequence: nextSequence };
  if (result.status === "written" && result.cleanupWarning) {
    return { ok: false, status: "commit_failed", reason: "commit_uncertain", detail: result.cleanupWarning, remedy: INTEGRITY_REASON_REMEDIES.commit_uncertain };
  }
  if (result.status === "held") {
    const parsed = parseHold(result.message);
    return { ok: false, status: "commit_conflict", reason: parsed.reason, detail: parsed.detail, remedy: INTEGRITY_REASON_REMEDIES[parsed.reason] };
  }
  return { ok: false, status: "commit_failed", reason: "unavailable", detail: result.message || String(result.cleanupWarning), remedy: INTEGRITY_REASON_REMEDIES.unavailable };
}

// ── small readers for later slices ──────────────────────────────────────────

export function generationNumbers(paths: IntegrityPaths): number[] {
  return listGenerationFiles(paths.generationsDir)
    .map((name) => Number.parseInt(basename(name, ".json"), 10))
    .filter((value) => Number.isSafeInteger(value));
}

export function readCurrentPointer(paths: IntegrityPaths, key: Buffer):
  { kind: "ok"; pointer: IntegrityCurrentPointer } | { kind: "absent" } | { kind: "error"; reason: IntegrityReason; detail: string } {
  const read = readSignedJson(paths.currentPath, validateCurrentShape, key, "CURRENT");
  if (read.kind === "ok") return { kind: "ok", pointer: read.value };
  return read;
}
