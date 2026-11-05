/**
 * integrity-state.ts — evidence custody and the commit fence for the
 * integrity watcher (flair#971, slice 1a foundation).
 *
 * NOT REACHABLE YET. This module adds no command, resource or route. It is the
 * library half the enrollment and check slices build on:
 *
 *   - a v3 checkpoint whose fields other than `hmac` are covered by an
 *     HMAC-SHA256 over a canonical JSON encoding with a custody key;
 *   - the fixed twelve-reason taxonomy (strings, not prose) for callers to
 *     report;
 *   - the custody predicate: custody and generations directories 0700; key,
 *     registry, CURRENT and generation files 0600; these entries checked for
 *     symlinks and any ACL entry; a caller-supplied
 *     server uid that can neither read the key nor write state, and the
 *     recorded operator uid and machine identity compared when custody is
 *     opened and when a generation is committed;
 *   - an authenticated enrollment registry with a monotonic sequence and
 *     tombstones, plus retained generations;
 *   - generation numbers bounded on write and in the persisted checkpoint and
 *     CURRENT records to the twelve-digit filename format the listing accepts;
 *   - generation staging and uncertain-commit recovery under ONE custody lock
 *     (commit, tombstone, registry write and recovery all serialize on it);
 *   - custody ancestry: the custody directory, every ancestor up to the
 *     filesystem root, and the generations directory are identity-recorded at
 *     open and rechecked under the commit and tombstone lock, immediately before
 *     and after publication rename. Detected drift before rename refuses with
 *     custody_invalid; detected drift after rename reports commit_uncertain.
 *     A process that can write to an ancestor is outside the custody trust
 *     boundary and can still race the rename. Chain checks detect drift present
 *     when they run; they do not guarantee detection of an intervening race.
 *     Node cannot bind rename to an open directory descriptor.
 *
 * Callers decide whether to retry on `status`, never on `reason`: generation
 * exhaustion is `status: "commit_failed"` with `reason: "commit_conflict"`, so
 * a non-retryable refusal can carry the conflict reason.
 *
 * The custody key and state live in the caller-supplied custody directory.
 * Modes alone cannot prove a server cannot reach them. The enrollment registry
 * records the operator/machine pair, and `checkCustody` rechecks it at open and
 * at commit and refuses a same-machine same-uid arrangement; a test must
 * additionally demonstrate the real denial.
 */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

/** The largest generation a twelve-digit filename can carry. */
export const INTEGRITY_MAX_GENERATION = 999_999_999_999;

/** The same root-stopping ancestor-walk bound config-critical-section uses. */
const CUSTODY_CHAIN_MAX = 256;

/** The remedy for a custody chain that no longer matches the open handle. */
const CUSTODY_CHAIN_REMEDY = "Re-open custody to record the current directory chain, then retry.";

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const UNCERTAIN_COMMIT_PREFIX = "commit:";
const UNCERTAIN_REGISTRY_PREFIX = "registry:";

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

/** The remedy paired with each reason. */
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
  commit_conflict: "Resolve the generation or sequence mismatch and rerun.",
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

/** Sort object keys and preserve array order over plain JSON data properties. */
export function canonicalJson(value: unknown, location = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${location} is not a finite number`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`${location} is ${typeof value}, which is not plain JSON`);
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "length") continue;
      const descriptor = descriptors[key as string];
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length ||
          !descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${location} has a non-JSON array property`);
      }
    }
    const parts: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) throw new TypeError(`${location}[${index}] is a sparse array hole`);
      parts.push(canonicalJson(descriptor.value, `${location}[${index}]`));
    }
    return `[${parts.join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${location} is not a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${location} has a non-JSON object property`);
    }
  }
  return `{${(keys as string[]).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(descriptors[key]!.value, `${location}.${key}`)}`).join(",")}}`;
}

function hmacHex(payload: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(`flair-integrity-v3\n${canonicalJson(payload)}`).digest("hex");
}

/** Sign a record: returns the same fields plus `hmac`. */
export function signIntegrityRecord<T extends Record<string, unknown>>(record: T, key: Buffer): T & { hmac: string } {
  const { hmac: _ignored, ...payload } = JSON.parse(canonicalJson(record)) as Record<string, unknown>;
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
  custodyDir = resolve(custodyDir);
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

function isGenerationNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 1 && value <= INTEGRITY_MAX_GENERATION;
}

// ── custody ─────────────────────────────────────────────────────────────────

export interface CustodyCheckOptions {
  paths: IntegrityPaths;
  serverUid: number;
  operatorUid: number;
  machineId: string;
  expectedOperatorUid?: number;
  expectedMachineId?: string;
  /** Skip key/registry existence checks while initializing. */
  requireFiles?: boolean;
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
  allowAbsent = false,
): CustodyCheck {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && allowAbsent) return { ok: true };
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

/** The custody predicate. */
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
    const gens = checkManagedEntry(paths.generationsDir, "dir", operatorUid, true);
    if (!gens.ok) return gens;
  }
  const listed = listGenerationFiles(paths.generationsDir);
  if (listed.kind === "error") return { ok: false, reason: listed.reason, detail: listed.detail };
  if (listed.kind === "ok") {
    for (const name of listed.files) {
      const gen = checkManagedEntry(join(paths.generationsDir, name), "file", operatorUid);
      if (!gen.ok) return gen;
    }
  }
  if (requireFiles) {
    const current = checkManagedEntry(paths.currentPath, "file", operatorUid, true);
    if (!current.ok) return current;
  }
  return { ok: true };
}

/** One recorded path in the custody ancestry, including whether it is a symlink. */
export interface CustodyChainEntry {
  path: string;
  dev: number;
  ino: number;
  symbolicLink: boolean;
}

/** The custody directory, its ancestors from the filesystem root down, and the
 *  generations directory. The walk applies config-critical-section's rules: at
 *  most 256 ancestors including custody, plus the generations directory. */
function custodyChainPaths(
  custodyDir: string,
  generationsDir: string,
): { ok: true; paths: string[] } | { ok: false; detail: string } {
  const upward: string[] = [];
  let probe = custodyDir;
  for (let i = 0; ; i++) {
    if (i >= CUSTODY_CHAIN_MAX) {
      return { ok: false, detail: `ancestor walk reached its iteration cap for ${custodyDir}` };
    }
    upward.push(probe);
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  upward.reverse();
  upward.push(generationsDir);
  return { ok: true, paths: upward };
}

/** Record the identity of every custody-chain path with lstat, never following
 *  a final symlink. */
function recordCustodyChain(
  paths: IntegrityPaths,
): { ok: true; entries: CustodyChainEntry[] } | { ok: false; detail: string } {
  const chain = custodyChainPaths(paths.custodyDir, paths.generationsDir);
  if (!chain.ok) return chain;
  const entries: CustodyChainEntry[] = [];
  for (const path of chain.paths) {
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch (err) {
      return { ok: false, detail: `cannot record the identity of ${path}: ${msg(err)}` };
    }
    entries.push({ path, dev: st.dev, ino: st.ino, symbolicLink: st.isSymbolicLink() });
  }
  return { ok: true, entries };
}

/** Re-lstat the recorded chain and name the first path that no longer matches. */
function verifyCustodyChain(
  entries: readonly CustodyChainEntry[],
): { ok: true } | { ok: false; detail: string } {
  for (const entry of entries) {
    let st: Stats;
    try {
      st = lstatSync(entry.path);
    } catch (err) {
      const detail = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `${entry.path} disappeared after custody was opened`
        : `cannot re-stat ${entry.path}: ${msg(err)}`;
      return { ok: false, detail };
    }
    if (st.isSymbolicLink() && !entry.symbolicLink) {
      return { ok: false, detail: `${entry.path} became a symlink after custody was opened` };
    }
    if (!st.isSymbolicLink() && entry.symbolicLink) {
      return { ok: false, detail: `${entry.path} is no longer the symlink recorded at open` };
    }
    if (st.dev !== entry.dev || st.ino !== entry.ino) {
      return { ok: false, detail: `${entry.path} identity changed after custody was opened` };
    }
  }
  return { ok: true };
}

/** Read the machine identity: the platform, the hostname, and the platform's
 *  machine-id when that file is readable. A hostname can be shared or changed,
 *  so this value is only as identifying as the hostname when no machine-id is
 *  available; it is not proof of a unique machine. A missing machine-id is
 *  folded into the recorded value, not treated as an error. */
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
      // Absence is not an unknown for identity: the value falls back to the
      // hostname, which a renamed or cloned host can share.
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
function writeNewDurable(path: string, bytes: Uint8Array, mode: number, onCreated?: () => void): void {
  const fd = openSync(path, "wx", mode);
  try {
    onCreated?.();
    writeAllSync(fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  fsyncDir(dirname(path));
}

/** Replace a generation file atomically. The caller only reaches this for a
 *  number CURRENT does not name (the commit decision verified CURRENT names
 *  expectedGeneration and this writes expectedGeneration + 1); the function
 *  itself does not check that, so it cannot detect another writer. */
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

/** Shared by registry publication, commit, tombstone and recovery. */
function custodyLockPath(paths: IntegrityPaths): string {
  return join(paths.custodyDir, ".custody.lock");
}

type GenerationListing =
  | { kind: "ok"; files: string[] }
  | { kind: "absent" }
  | { kind: "error"; reason: IntegrityReason; detail: string };

/** ENOENT is the only "absent". Any other readdir failure is an error the
 *  callers must refuse, never an empty history. */
function listGenerationEntries(generationsDir: string): GenerationListing {
  let names: string[];
  try {
    names = readdirSync(generationsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "error", reason: "unavailable", detail: `cannot list ${generationsDir}: ${msg(err)}` };
  }
  return { kind: "ok", files: names.sort() };
}

function listGenerationFiles(generationsDir: string): GenerationListing {
  const listed = listGenerationEntries(generationsDir);
  if (listed.kind !== "ok") return listed;
  const unexpected = listed.files.find((name) => !/^\d{12}\.json$/.test(name));
  if (unexpected !== undefined) {
    return { kind: "error", reason: "custody_invalid", detail: `unexpected generation entry ${JSON.stringify(unexpected)}` };
  }
  return listed;
}

type HistoryCheck =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "error"; reason: IntegrityReason; detail: string };

function hasGenerationHistory(paths: IntegrityPaths): HistoryCheck {
  try {
    lstatSync(paths.currentPath);
    return { kind: "yes" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { kind: "error", reason: "unavailable", detail: `cannot stat CURRENT: ${msg(err)}` };
    }
  }
  const listed = listGenerationEntries(paths.generationsDir);
  if (listed.kind === "error") return listed;
  return listed.kind === "ok" && listed.files.length > 0 ? { kind: "yes" } : { kind: "no" };
}

/** Write the durable intent marker BEFORE publication. A failure here must
 *  refuse the publication. `beforeWrite` is the test seam that injects such a
 *  failure after the commit decision succeeded. */
function writeUncertainMarker(paths: IntegrityPaths, value: string, beforeWrite?: () => void): void {
  beforeWrite?.();
  let created = false;
  try {
    writeNewDurable(paths.uncertainPath, Buffer.from(value, "utf-8"), 0o600, () => { created = true; });
  } catch (err) {
    if (created) {
      try { clearUncertainMarker(paths); } catch { }
    }
    throw err;
  }
}

/** Remove the marker after durable completion (or after a publication that
 *  did not land). Throws unless the marker is already absent; callers decide
 *  whether a failure is fatal. */
function clearUncertainMarker(paths: IntegrityPaths): void {
  try {
    unlinkSync(paths.uncertainPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  fsyncDir(paths.custodyDir);
}

type MarkerRead =
  | { kind: "absent" }
  | { kind: "value"; value: string }
  | { kind: "error"; detail: string };

function readUncertainMarker(paths: IntegrityPaths): MarkerRead {
  let value: string;
  try {
    value = readFileSync(paths.uncertainPath, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "error", detail: `cannot read the uncertainty marker: ${msg(err)}` };
  }
  return { kind: "value", value };
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
    if (entry.tombstonedAt !== undefined && typeof entry.tombstonedAt !== "string") return false;
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
  if (!isGenerationNumber(c.generation)) return false;
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
  if (c.journal !== undefined) {
    if (!Array.isArray(c.journal)) return false;
    for (const raw of c.journal) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.at !== "string" || typeof entry.kind !== "string") return false;
      if (entry.detail !== undefined && typeof entry.detail !== "string") return false;
    }
  }
  if (c.pendingEvents !== undefined && !Array.isArray(c.pendingEvents)) return false;
  return true;
}

function validateCurrentShape(value: unknown): value is IntegrityCurrentPointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return c.version === 3 && c.kind === "current" &&
    typeof c.enrollmentId === "string" && c.enrollmentId.length > 0 &&
    isGenerationNumber(c.generation) &&
    typeof c.hmac === "string";
}

type CustodyRecord = IntegrityRegistry | IntegrityCheckpointV3 | IntegrityCurrentPointer;

function prepareIntegrityRecord<T extends CustodyRecord>(
  build: () => Omit<T, "hmac">,
  key: Buffer,
): T {
  const record = Object.create(null) as T & Record<string, unknown>;
  for (const [field, value] of Object.entries(JSON.parse(canonicalJson(build())))) record[field] = value;
  record.hmac = "";
  const counters = record.kind === "registry"
    ? [record.sequence, ...record.entries.map((entry) => entry.sequence)]
    : [record.generation, ...(record.kind === "checkpoint" ? Object.values(record.baseline.byDurability) : [])];
  if (counters.some((value) => !Number.isSafeInteger(value))) {
    throw new RangeError("integrity sequence, generation or count exceeds the safe integer range");
  }
  const validator: (value: unknown) => boolean = record.kind === "registry" ? validateRegistryShape
    : record.kind === "checkpoint" ? validateCheckpointShape : validateCurrentShape;
  if (!validator(record)) throw new TypeError(`invalid v3 integrity ${record.kind} shape`);
  return signIntegrityRecord(record, key) as T;
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
  /** Identity of the custody directory, its ancestors and the generations
   *  directory recorded when this handle was opened. */
  custodyChain: CustodyChainEntry[];
  key: Buffer;
  registry: IntegrityRegistry;
  enrollment: IntegrityEnrollmentEntry;
  checkpoint: IntegrityCheckpointV3 | null;
  generation: number;
  operatorUid: number;
  machineId: string;
  serverUid: number;
  /** Where the caller's server uid came from. */
  serverUidSource: string;
  /** True when this open reconciled an uncertain commit before returning. */
  recovered: boolean;
}

export type IntegrityStateResult =
  | { ok: true; state: IntegrityStateHandle }
  | { ok: false; reason: IntegrityReason; detail: string; remedy: string };

export type CommitStatus = "committed" | "commit_conflict" | "commit_uncertain" | "commit_failed";

/** Decide retry on `status`, never on `reason`: `commit_conflict` reports a
 *  generation or sequence mismatch. Exhaustion reports `commit_failed` with
 *  reason `commit_conflict`; `commit_uncertain` requires recovery. */
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
  /** Caller-supplied server uid; requires a nonempty `serverUidSource` label. */
  serverUid?: number;
  serverUidSource?: string;
  operatorUid?: number;
  machineId?: string;
  enrollmentId?: string;
  newCustody?: boolean;
  /** TEST-ONLY seam: runs after the registry-absence check and before the
   *  locked new-custody publication. */
  beforeRegistryPublication?: () => void;
}

export interface CommitGenerationOptions {
  state: IntegrityStateHandle;
  /** Generation observed before the scan. A mismatch holds the write. */
  expectedGeneration: number;
  checkpoint: Omit<IntegrityCheckpointPayload, "version" | "kind" | "enrollmentId" | "generation" | "operatorUid" | "machineId">;
  /** TEST-ONLY barriers. The shared critical-section hooks are passed through;
   *  `beforeUncertainMarkerWrite` fires after the decision succeeded and before
   *  the intent marker is created. */
  testHooks?: NonNullable<ConfigSectionOptions["testHooks"]> & {
    beforeUncertainMarkerWrite?: () => void;
  };
}

function fail(reason: IntegrityReason, detail: string): IntegrityStateResult {
  return { ok: false, reason, detail, remedy: INTEGRITY_REASON_REMEDIES[reason] };
}

function resolveServerUid(opts: IntegrityStateOptions): { ok: true; uid: number; source: string } | { ok: false; detail: string } {
  if (opts.serverUid === undefined) {
    return { ok: false, detail: "no server uid was supplied; the caller must measure it and name the measurement source" };
  }
  if (typeof opts.serverUidSource !== "string" || opts.serverUidSource.trim().length === 0) {
    return { ok: false, detail: "the server uid has no recorded source" };
  }
  return { ok: true, uid: opts.serverUid, source: opts.serverUidSource };
}

function readKey(paths: IntegrityPaths): { ok: true; key: Buffer } | { ok: false; reason: IntegrityReason; detail: string; absent?: boolean } {
  let key: Buffer;
  try {
    key = readFileSync(paths.keyPath);
  } catch (err) {
    return { ok: false, reason: "unavailable", absent: (err as NodeJS.ErrnoException).code === "ENOENT", detail: `cannot read the custody key: ${msg(err)}` };
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

// ── custody lock and uncertainty recovery ───────────────────────────────────

/** Run `action` under the ONE custody lock. Recovery is a state mutation too,
 *  so it serializes with commits and tombstones. */
function withCustodyLock(paths: IntegrityPaths, action: () => void): { ok: true } | { ok: false; detail: string } {
  try {
    const result = withConfigCriticalSection(paths.registryPath, () => {
      action();
      return { noop: "custody recovery" };
    }, { lockPath: custodyLockPath(paths) });
    if (result.status === "noop") return { ok: true };
    return { ok: false, detail: result.message };
  } catch (err) {
    return { ok: false, detail: `the custody lock failed: ${msg(err)}` };
  }
}

type MarkerReconcile =
  | { ok: true; recovered: boolean }
  | { ok: false; reason: IntegrityReason; detail: string };

function parseUncertainMarker(raw: string): { kind: "commit" | "registry"; value: number } | null {
  for (const [kind, prefix] of [["commit", UNCERTAIN_COMMIT_PREFIX], ["registry", UNCERTAIN_REGISTRY_PREFIX]] as const) {
    if (!raw.startsWith(prefix)) continue;
    const value = Number(raw.slice(prefix.length));
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return { kind, value };
  }
  return null;
}

/** Reconcile publication intent against the published record. A commit marker
 *  ahead of an existing CURRENT is retained as commit_uncertain. */
function reconcileUncertainMarker(paths: IntegrityPaths, key: Buffer, checkpoint: IntegrityCheckpointV3 | null): MarkerReconcile {
  let outcome: MarkerReconcile = { ok: true, recovered: false };
  const locked = withCustodyLock(paths, () => {
    const marker = readUncertainMarker(paths);
    if (marker.kind === "absent") return;
    if (marker.kind === "error") {
      outcome = { ok: false, reason: "unavailable", detail: marker.detail };
      throw new Error(marker.detail);
    }
    const parsed = parseUncertainMarker(marker.value);
    if (parsed === null) {
      outcome = { ok: false, reason: "commit_uncertain", detail: `the uncertainty marker ${JSON.stringify(marker.value)} is not a recognized intent` };
      throw new Error("unrecognized uncertainty marker");
    }
    if (parsed.kind === "registry") {
      const read = readRegistry(paths, key);
      if (read.kind === "error") {
        outcome = { ok: false, reason: read.reason, detail: read.detail };
        throw new Error(read.detail);
      }
      if (read.kind === "absent") {
        outcome = { ok: false, reason: "commit_uncertain", detail: "the uncertainty marker names a registry write but the registry is absent" };
        throw new Error("registry absent");
      }
      if (read.registry.sequence > parsed.value) {
        outcome = { ok: false, reason: "commit_uncertain", detail: `the uncertainty marker names registry sequence ${parsed.value}, but the registry is at ${read.registry.sequence}` };
        throw new Error("registry sequence ahead");
      }
      if (read.registry.sequence === parsed.value) {
        try {
          fsyncFile(paths.registryPath);
          fsyncDir(paths.custodyDir);
        } catch (err) {
          outcome = { ok: false, reason: "commit_uncertain", detail: `cannot recover the uncertain registry write: ${msg(err)}` };
          throw err;
        }
        outcome = { ok: true, recovered: true };
      }
    } else {
      if (checkpoint === null) {
        // Leave a commit marker for the caller that resolves CURRENT.
        return;
      }
      if (parsed.value > checkpoint.generation) {
        outcome = { ok: false, reason: "commit_uncertain", detail: `the uncertainty marker names generation ${parsed.value}, but the current generation is ${checkpoint.generation}` };
        throw new Error("generation ahead");
      }
      if (parsed.value === checkpoint.generation) {
        try {
          fsyncFile(generationPath(paths.generationsDir, checkpoint.generation));
          fsyncDir(paths.generationsDir);
          fsyncDir(paths.custodyDir);
        } catch (err) {
          outcome = { ok: false, reason: "commit_uncertain", detail: `cannot recover the uncertain commit: ${msg(err)}` };
          throw err;
        }
        outcome = { ok: true, recovered: true };
      }
    }
    try {
      unlinkSync(paths.uncertainPath);
      fsyncDir(paths.custodyDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        outcome = { ok: false, reason: "commit_uncertain", detail: `cannot clear the uncertainty marker: ${msg(err)}` };
        throw err;
      }
    }
  });
  if (!locked.ok && outcome.ok) return { ok: false, reason: "unavailable", detail: locked.detail };
  return outcome;
}

// ── initialization and open ─────────────────────────────────────────────────

function createInitialRegistry(key: Buffer, operatorUid: number, machineId: string): IntegrityRegistry {
  const enrollmentId = `enr_${randomBytes(16).toString("hex")}`;
  return prepareIntegrityRecord<IntegrityRegistry>(() => ({
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
  }), key);
}

function writeInitialRegistry(
  paths: IntegrityPaths,
  registry: IntegrityRegistry,
): { ok: true; registry: IntegrityRegistry } | { ok: false; reason: IntegrityReason; detail: string } {
  const result = withConfigCriticalSection(paths.registryPath, (bytes) => {
    if (bytes !== null) {
      return { hold: "custody_invalid: the registry already exists; refusing to re-initialize it" };
    }
    return { write: jsonBytes(registry) };
  }, { lockPath: custodyLockPath(paths) });
  if (result.status === "written" && !result.cleanupWarning) return { ok: true, registry };
  if (result.status === "written") return { ok: false, reason: "commit_uncertain", detail: result.cleanupWarning! };
  if (result.status === "held") {
    const parsed = parseHold(result.message);
    return { ok: false, reason: parsed.reason, detail: parsed.detail };
  }
  return { ok: false, reason: "unavailable", detail: result.message };
}

function openWithRegistry(
  paths: IntegrityPaths,
  key: Buffer,
  registry: IntegrityRegistry,
  opts: IntegrityStateOptions,
  operatorUid: number,
  machineId: string,
  serverUid: number,
  serverUidSource: string,
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
  });
  if (!custody.ok) return fail(custody.reason, custody.detail);

  let recovered = false;
  const current = readSignedJson(paths.currentPath, validateCurrentShape, key, "CURRENT");
  if (current.kind === "error") return fail(current.reason, current.detail);

  let checkpoint: IntegrityCheckpointV3 | null = null;
  if (current.kind === "absent") {
    // A staged generation is never commit evidence on its own: only CURRENT
    // names the published generation. Refuse any retained directory entry.
    const history = hasGenerationHistory(paths);
    if (history.kind === "error") return fail(history.reason, history.detail);
    if (history.kind === "yes") {
      return fail("custody_invalid", "CURRENT is absent while generation history exists; a staged generation is not commit evidence");
    }
    if (!allowEmpty) return fail("checkpoint_missing", "no CURRENT pointer and no retained generation");
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

  const reconciled = reconcileUncertainMarker(paths, key, checkpoint);
  if (!reconciled.ok) return fail(reconciled.reason, reconciled.detail);
  if (reconciled.recovered) recovered = true;

  const chain = recordCustodyChain(paths);
  if (!chain.ok) return fail("custody_invalid", chain.detail);

  return {
    ok: true,
    state: {
      paths,
      custodyChain: chain.entries,
      key,
      registry,
      enrollment,
      checkpoint,
      generation: checkpoint?.generation ?? 0,
      operatorUid,
      machineId,
      serverUid,
      serverUidSource,
      recovered,
    },
  };
}

/** Create custody for a genuine first use. `newCustody: true` is required: an
 *  absent registry with generation history is `custody_invalid`, never
 *  `uninitialized` (N5), and an existing registry is not re-initialized. */
export function initializeIntegrityCustody(opts: IntegrityStateOptions): IntegrityStateResult {
  const uid = opts.operatorUid ?? currentUid();
  if (uid === null) return fail("custody_invalid", "the process has no uid; custody cannot be established");
  const machineId = opts.machineId ?? machineIdentity();
  const derived = resolveServerUid(opts);
  if (!derived.ok) return fail("custody_invalid", derived.detail);
  if (derived.uid === uid || derived.uid === 0) {
    return fail("custody_invalid", "the server uid and the operator uid must differ, and the server must not be root");
  }

  const paths = integrityPaths(opts.custodyDir);
  try {
    if (lstatSync(paths.custodyDir, { throwIfNoEntry: false }) !== undefined) {
      const dir = checkManagedEntry(paths.custodyDir, "dir", uid);
      if (!dir.ok) return fail(dir.reason, dir.detail);
    }
  } catch (err) {
    return fail("unavailable", `cannot inspect the custody directory: ${msg(err)}`);
  }
  const fsCheck = assertSupportedLocalFilesystem(paths.custodyDir);
  if (!fsCheck.ok) return fail("custody_invalid", fsCheck.reason);

  let registryPresent: boolean;
  try {
    lstatSync(paths.registryPath);
    registryPresent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return fail("unavailable", `cannot inspect the registry: ${msg(err)}`);
    }
    registryPresent = false;
  }
  if (registryPresent) {
    const registryEntry = checkManagedEntry(paths.registryPath, "file", uid);
    if (!registryEntry.ok) return fail(registryEntry.reason, registryEntry.detail);
    const keyEntry = checkManagedEntry(paths.keyPath, "file", uid, true);
    if (!keyEntry.ok) return fail(keyEntry.reason, keyEntry.detail);
    const key = readKey(paths);
    if (!key.ok) return fail(key.reason, key.detail);
    const read = readRegistry(paths, key.key);
    if (read.kind === "absent") return fail("unavailable", "the registry disappeared during initialization");
    if (read.kind === "error") return fail(read.reason, read.detail);
    return fail("custody_invalid", "custody is already initialized; use the existing state");
  }
  const history = hasGenerationHistory(paths);
  if (history.kind === "error") return fail(history.reason, history.detail);
  if (history.kind === "yes") {
    return fail("custody_invalid", "the registry is absent but generation history exists; refusing to mint a new custody root");
  }
  if (opts.newCustody !== true) {
    return fail("uninitialized", "first use requires an explicit new-custody flag");
  }

  const keyBytes = randomBytes(32);
  let initialRegistry: IntegrityRegistry;
  try {
    initialRegistry = createInitialRegistry(keyBytes, uid, machineId);
  } catch (err) {
    return fail("custody_invalid", `cannot prepare the initial registry: ${msg(err)}`);
  }

  try {
    mkdirSync(paths.custodyDir, { recursive: true, mode: 0o700 });
    const dir = checkCustody({ paths, serverUid: derived.uid, operatorUid: uid, machineId, requireFiles: false });
    if (!dir.ok) return fail(dir.reason, dir.detail);
    mkdirSync(paths.generationsDir, { recursive: true, mode: 0o700 });
    const generations = checkManagedEntry(paths.generationsDir, "dir", uid);
    if (!generations.ok) return fail(generations.reason, generations.detail);
    const filesystem = ensureLocalFilesystem(paths);
    if (!filesystem.ok) return fail(filesystem.reason, filesystem.detail);
    writeNewDurable(paths.keyPath, keyBytes, 0o600);
    fsyncDir(paths.custodyDir);
  } catch (err) {
    return fail("unavailable", `creating custody failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const key = readKey(paths);
  if (!key.ok) return fail(key.reason, key.detail);
  opts.beforeRegistryPublication?.();
  const written = writeInitialRegistry(paths, initialRegistry);
  if (!written.ok) return fail(written.reason, written.detail);
  const registry = written.registry;

  const custody = checkCustody({
    paths,
    serverUid: derived.uid,
    operatorUid: uid,
    machineId,
    expectedOperatorUid: uid,
    expectedMachineId: machineId,
  });
  if (!custody.ok) return fail(custody.reason, custody.detail);

  return openWithRegistry(paths, key.key, registry, opts, uid, machineId, derived.uid, derived.source, true);
}

/** Open existing custody and recover an interrupted commit. */
export function openIntegrityState(opts: IntegrityStateOptions): IntegrityStateResult {
  const uid = opts.operatorUid ?? currentUid();
  if (uid === null) return fail("custody_invalid", "the process has no uid; custody cannot be verified");
  const machineId = opts.machineId ?? machineIdentity();
  const derived = resolveServerUid(opts);
  if (!derived.ok) return fail("custody_invalid", derived.detail);
  if (derived.uid === uid || derived.uid === 0) {
    return fail("custody_invalid", "the server uid and the operator uid must differ, and the server must not be root");
  }

  const paths = integrityPaths(opts.custodyDir);
  for (const [managed, kind] of [
    [paths.custodyDir, "dir"], [paths.generationsDir, "dir"],
    [paths.keyPath, "file"], [paths.registryPath, "file"], [paths.currentPath, "file"],
  ] as const) {
    const check = checkManagedEntry(managed, kind, uid, true);
    if (!check.ok) return fail(check.reason, check.detail);
  }

  const fsCheck = ensureLocalFilesystem(paths);
  if (!fsCheck.ok) return fail(fsCheck.reason, fsCheck.detail);

  const key = readKey(paths);
  if (!key.ok) {
    if (key.reason === "unavailable" && key.absent) {
      const history = hasGenerationHistory(paths);
      if (history.kind === "error") return fail(history.reason, history.detail);
      if (history.kind === "yes") return fail("custody_invalid", "the key is absent while generation history exists");
      try {
        if ([paths.custodyDir, paths.keyPath, paths.registryPath].every((path) => lstatSync(path, { throwIfNoEntry: false }) === undefined)) {
          return fail("uninitialized", "no custody exists; an explicit new-custody enrollment is required");
        }
      } catch (err) {
        return fail("unavailable", `cannot inspect custody: ${msg(err)}`);
      }
    }
    return fail(key.reason, key.detail);
  }

  const read = readRegistry(paths, key.key);
  if (read.kind === "absent") {
    const history = hasGenerationHistory(paths);
    if (history.kind === "error") return fail(history.reason, history.detail);
    if (history.kind === "yes") {
      return fail("custody_invalid", "the registry is absent but generation history exists; refusing to treat this as first use");
    }
    return fail("uninitialized", "no custody registry exists; an explicit new-custody enrollment is required");
  }
  if (read.kind === "error") return fail(read.reason, read.detail);

  const marker = reconcileUncertainMarker(paths, key.key, null);
  if (!marker.ok) return fail(marker.reason, marker.detail);

  return openWithRegistry(paths, key.key, read.registry, opts, uid, machineId, derived.uid, derived.source, false);
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

function parseHold(message: string): { reason: IntegrityReason; detail: string; recognized: boolean } {
  const [head, ...rest] = message.split(":");
  if ((INTEGRITY_REASONS as readonly string[]).includes(head!) && rest.length > 0) {
    return { reason: head as IntegrityReason, detail: rest.join(":").trim(), recognized: true };
  }
  // An unrecognized hold reports a non-retryable status.
  return { reason: "commit_conflict", detail: message, recognized: false };
}

/** A recognized generation or sequence mismatch maps to `commit_conflict`;
 *  every other hold maps to `commit_failed`. */
function holdStatus(parsed: { reason: IntegrityReason; recognized: boolean }): "commit_conflict" | "commit_failed" {
  return parsed.recognized && parsed.reason === "commit_conflict" ? "commit_conflict" : "commit_failed";
}

type CustodyPublicationFailure = {
  ok: false;
  status: "commit_failed" | "commit_uncertain";
  reason: "custody_invalid" | "commit_uncertain";
  detail: string;
  remedy: string;
};

function custodyPublicationChecks(
  chain: readonly CustodyChainEntry[],
  refuse: (failure: CustodyPublicationFailure) => void,
  uncertainRemedy: string,
): Pick<ConfigSectionOptions, "beforeRename" | "afterRename"> {
  return {
    beforeRename: () => {
      const checked = verifyCustodyChain(chain);
      if (checked.ok) return;
      refuse({ ok: false, status: "commit_failed", reason: "custody_invalid", detail: checked.detail, remedy: CUSTODY_CHAIN_REMEDY });
      throw new Error(checked.detail);
    },
    afterRename: () => {
      const checked = verifyCustodyChain(chain);
      if (checked.ok) return;
      refuse({ ok: false, status: "commit_uncertain", reason: "commit_uncertain", detail: checked.detail, remedy: uncertainRemedy });
      throw new Error(checked.detail);
    },
  };
}

/**
 * Commit a generation under the ONE custody lock.
 *
 * The pre-scan generation is rechecked inside `decide`; a mismatch returns
 * `commit_conflict` and never writes. The generation and a durable intent
 * marker are staged under the ONE custody lock before CURRENT is replaced.
 * A post-rename directory-fsync warning is `commit_uncertain`, never success.
 */
export function commitGeneration(opts: CommitGenerationOptions): CommitGenerationResult {
  const { state } = opts;
  if (!Number.isSafeInteger(opts.expectedGeneration) || opts.expectedGeneration < 0 ||
      opts.expectedGeneration > INTEGRITY_MAX_GENERATION) {
    return { ok: false, status: "commit_failed", reason: "commit_conflict", detail: `the expected generation must be a non-negative integer at or below the twelve-digit bound ${INTEGRITY_MAX_GENERATION}`, remedy: "Use the generation from the opened custody state." };
  }

  const measuredOperatorUid = currentUid();
  if (measuredOperatorUid === null) {
    return { ok: false, status: "commit_failed", reason: "custody_invalid", detail: "the process has no uid", remedy: INTEGRITY_REASON_REMEDIES.custody_invalid };
  }
  if (measuredOperatorUid !== state.operatorUid) {
    return { ok: false, status: "commit_failed", reason: "custody_invalid", detail: `the operator uid changed from the recorded ${state.operatorUid} to ${measuredOperatorUid}`, remedy: INTEGRITY_REASON_REMEDIES.custody_invalid };
  }
  const measuredMachineId = machineIdentity();
  if (measuredMachineId !== state.machineId) {
    return { ok: false, status: "commit_failed", reason: "custody_invalid", detail: "the machine identity differs from the opened handle", remedy: INTEGRITY_REASON_REMEDIES.custody_invalid };
  }

  // The ancestry is checked before the custody predicate because the predicate
  // reports a vanished custody directory as checkpoint_missing; the caller
  // needs the path that moved. The same check runs again under the lock.
  const chainBefore = verifyCustodyChain(state.custodyChain);
  if (!chainBefore.ok) {
    return { ok: false, status: "commit_failed", reason: "custody_invalid", detail: chainBefore.detail, remedy: CUSTODY_CHAIN_REMEDY };
  }

  const custody = checkCustody({
    paths: state.paths,
    serverUid: state.serverUid,
    operatorUid: measuredOperatorUid,
    machineId: measuredMachineId,
    expectedOperatorUid: state.enrollment.operatorUid,
    expectedMachineId: state.enrollment.machineId,
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
  let generationBytes: Uint8Array;
  let refusal: Extract<CommitGenerationResult, { ok: false }> | undefined;

  const decide = (bytes: Uint8Array | null): { write: Uint8Array } | { hold: string } => {
    // First check under the lock: a custody chain that no longer matches the
    // opened handle must not write an intent marker or a generation.
    const chain = verifyCustodyChain(state.custodyChain);
    if (!chain.ok) {
      refusal = {
        ok: false,
        status: "commit_failed",
        reason: "custody_invalid",
        detail: chain.detail,
        remedy: CUSTODY_CHAIN_REMEDY,
      };
      return holdMessage(refusal.reason, refusal.detail);
    }
    const marker = readUncertainMarker(state.paths);
    if (marker.kind === "error") return holdMessage("unavailable", marker.detail);
    if (marker.kind === "value") return holdMessage("commit_uncertain", "publication requires uncertainty reconciliation");
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

    if (bytes === null) {
      // CURRENT is absent. Generation one is publishable only into an empty
      // history: a retained entry (or a directory that cannot be listed) means
      // the absent pointer is lost evidence, not a fresh start.
      const history = listGenerationEntries(state.paths.generationsDir);
      if (history.kind === "error") return holdMessage(history.reason, history.detail);
      if (history.kind === "ok" && history.files.length > 0) {
        return holdMessage("custody_invalid", "CURRENT is absent while generation history exists");
      }
    }

    let onDisk = 0;
    if (bytes !== null) {
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
    // Compare the on-disk generation with the pre-scan expectation.
    if (onDisk !== opts.expectedGeneration) {
      return holdMessage("commit_conflict", `the on-disk generation is ${onDisk}, expected ${opts.expectedGeneration}`);
    }
    if (onDisk === INTEGRITY_MAX_GENERATION) {
      refusal = { ok: false, status: "commit_failed", reason: "commit_conflict", detail: "the generation sequence has reached its twelve-digit limit", remedy: "The generation sequence has reached its twelve-digit limit; no further generation can be committed to this custody. Start a new custody in a different custodyDir with initializeIntegrityCustody and newCustody: true." };
      return holdMessage(refusal.reason, refusal.detail);
    }

    try {
      const checkpoint = prepareIntegrityRecord<IntegrityCheckpointV3>(() => checkpointPayloadFor(opts, nextGeneration), state.key);
      const pointer = prepareIntegrityRecord<IntegrityCurrentPointer>(() => ({
        version: INTEGRITY_STATE_VERSION,
        kind: "current",
        enrollmentId: state.enrollment.enrollmentId,
        generation: nextGeneration,
      }), state.key);
      generationBytes = jsonBytes(checkpoint);
      return { write: jsonBytes(pointer) };
    } catch (err) {
      refusal = {
        ok: false,
        status: "commit_failed",
        reason: "checkpoint_incompatible",
        detail: `cannot prepare the checkpoint: ${msg(err)}`,
        remedy: INTEGRITY_REASON_REMEDIES.checkpoint_incompatible,
      };
      return holdMessage(refusal.reason, refusal.detail);
    }
  };

  const stage = (): (() => void) => {
    const path = generationPath(state.paths.generationsDir, nextGeneration);
    try {
      writeNewDurable(path, generationBytes, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readFileSync(path);
      if (!Buffer.from(generationBytes).equals(existing)) {
        // CURRENT still names expectedGeneration (checked in decide), so this
        // number is unreferenced: an orphan left by an earlier attempt that
        // staged but did not publish. Replace it. A file another writer put at
        // a number CURRENT names is outside what this check can see.
        replaceDurable(path, generationBytes, 0o600);
      }
    }
    // Durable intent marker BEFORE publication. A failure of the target
    // replacement's directory fsync reports commit_uncertain with marker
    // clearing skipped, so the marker preserves the uncertainty. A marker
    // clear that unlinks the marker but fails to fsync the custody directory
    // also reports commit_uncertain, with the marker already gone. Failure
    // here refuses the publication.
    writeUncertainMarker(state.paths, `${UNCERTAIN_COMMIT_PREFIX}${nextGeneration}`, opts.testHooks?.beforeUncertainMarkerWrite);
    return () => { try { clearUncertainMarker(state.paths); } catch { } };
  };

  let result: ConfigSectionResult;
  try {
    result = withConfigCriticalSection(state.paths.currentPath, decide, {
      stage,
      ...custodyPublicationChecks(state.custodyChain, (failure) => { refusal = failure; }, "Re-open custody and verify the generation."),
      lockPath: custodyLockPath(state.paths),
      onCommitted: () => clearUncertainMarker(state.paths),
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

  if (refusal) return refusal;
  if (result.status === "written") {
    if (result.cleanupWarning) {
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
    // The primitive can hold before `decide` when the custody parent no longer
    // resolves; recheck the chain so a replaced ancestor names its path rather
    // than surfacing a generic observe failure.
    const chain = verifyCustodyChain(state.custodyChain);
    if (!chain.ok) {
      return { ok: false, status: "commit_failed", reason: "custody_invalid", detail: chain.detail, remedy: CUSTODY_CHAIN_REMEDY };
    }
    const parsed = parseHold(result.message);
    return {
      ok: false,
      status: holdStatus(parsed),
      reason: parsed.reason,
      detail: parsed.detail,
      remedy: INTEGRITY_REASON_REMEDIES[parsed.reason],
    };
  }

  // refused: the target was not replaced; staged files may remain.
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
  /** TEST-ONLY barriers, from the shared critical section. */
  testHooks?: ConfigSectionOptions["testHooks"];
}

export type TombstoneResult =
  | { ok: true; sequence: number }
  | { ok: false; status: "commit_conflict" | "commit_failed" | "commit_uncertain"; reason: IntegrityReason; detail: string; remedy: string };

/** Tombstone an enrollment under the same custody lock as commit, relying on
 *  the opened handle's supplied identity. A stale sequence expectation holds. */
export function tombstoneEnrollment(opts: TombstoneOptions): TombstoneResult {
  const opened = openIntegrityState(opts);
  if (!opened.ok) return { ok: false, status: "commit_failed", reason: opened.reason, detail: opened.detail, remedy: opened.remedy };
  const state = opened.state;
  const enrollmentId = opts.enrollmentId ?? state.enrollment.enrollmentId;
  let nextSequence = 0;
  let chainRefusal: Extract<TombstoneResult, { ok: false }> | undefined;
  const decide = (bytes: Uint8Array | null): { write: Uint8Array } | { hold: string } => {
    // Recheck the same ancestry as commit before the registry intent marker.
    const chain = verifyCustodyChain(state.custodyChain);
    if (!chain.ok) {
      chainRefusal = { ok: false, status: "commit_failed", reason: "custody_invalid", detail: chain.detail, remedy: CUSTODY_CHAIN_REMEDY };
      return holdMessage(chainRefusal.reason, chainRefusal.detail);
    }
    const marker = readUncertainMarker(state.paths);
    if (marker.kind === "error") return holdMessage("unavailable", marker.detail);
    if (marker.kind === "value") return holdMessage("commit_uncertain", "publication requires uncertainty reconciliation");
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
    const updated = prepareIntegrityRecord<IntegrityRegistry>(() => ({
      version: INTEGRITY_STATE_VERSION,
      kind: "registry",
      sequence: nextSequence,
      entries: registry.entries.map((candidate) => candidate.enrollmentId === enrollmentId
        ? { ...candidate, status: "tombstoned" as const, tombstonedAt: new Date().toISOString() }
        : candidate),
    }), state.key);
    return { write: jsonBytes(updated) };
  };
  const stage = (): (() => void) => {
    writeUncertainMarker(state.paths, `${UNCERTAIN_REGISTRY_PREFIX}${nextSequence}`);
    return () => { try { clearUncertainMarker(state.paths); } catch { } };
  };
  let result: ConfigSectionResult;
  try {
    result = withConfigCriticalSection(state.paths.registryPath, decide, {
      stage,
      ...custodyPublicationChecks(state.custodyChain, (failure) => { chainRefusal = failure; }, "Re-open custody, reconcile uncertainty, then verify the authenticated registry sequence and the enrollment's tombstone status."),
      lockPath: custodyLockPath(state.paths),
      onCommitted: () => clearUncertainMarker(state.paths),
      testHooks: opts.testHooks,
    });
  } catch (err) {
    return { ok: false, status: "commit_failed", reason: "unavailable", detail: `the tombstone fence failed before replacing the registry: ${msg(err)}`, remedy: INTEGRITY_REASON_REMEDIES.unavailable };
  }
  if (chainRefusal) return chainRefusal;
  if (result.status === "written" && !result.cleanupWarning) {
    return { ok: true, sequence: nextSequence };
  }
  if (result.status === "written" && result.cleanupWarning) {
    return { ok: false, status: "commit_failed", reason: "commit_uncertain", detail: result.cleanupWarning, remedy: INTEGRITY_REASON_REMEDIES.commit_uncertain };
  }
  if (result.status === "held") {
    const chain = verifyCustodyChain(state.custodyChain);
    if (!chain.ok) {
      return { ok: false, status: "commit_failed", reason: "custody_invalid", detail: chain.detail, remedy: CUSTODY_CHAIN_REMEDY };
    }
    const parsed = parseHold(result.message);
    return { ok: false, status: holdStatus(parsed), reason: parsed.reason, detail: parsed.detail, remedy: INTEGRITY_REASON_REMEDIES[parsed.reason] };
  }
  return { ok: false, status: "commit_failed", reason: "unavailable", detail: result.message || String(result.cleanupWarning), remedy: INTEGRITY_REASON_REMEDIES.unavailable };
}

// ── small readers for later slices ──────────────────────────────────────────

export function generationNumbers(paths: IntegrityPaths): number[] {
  const listed = listGenerationFiles(paths.generationsDir);
  if (listed.kind === "error") throw new Error(listed.detail);
  if (listed.kind === "absent") return [];
  return listed.files
    .map((name) => Number.parseInt(basename(name, ".json"), 10))
    .filter((value) => Number.isSafeInteger(value));
}
