/**
 * backup-approval-store.ts — the target host's local store of approved backup
 * archives (flair#2664 slice 1c).
 *
 * The operator approves exact archive bytes on the host that will restore
 * them. The store is plain files under the operator's home, never a Harper
 * table, and nothing on the server's REST surface reads or writes it:
 *
 *   ~/.flair/approved-archives/            0700, owned by the current user
 *     archives/                            0700
 *       <sha256>.json                      0600, the archive's exact bytes
 *     approvals/                           0700
 *       <sha256>.json                      0600, the approval record
 *
 * Every store operation checks the root, both directories and every entry in
 * them before it creates anything in the store or reads a store file
 * (openStore); approval also checks this digest's existing record and stored
 * copy before it creates a missing directory. (The CLI reads the operator's
 * import file before it opens the store.) Each directory must be a real
 * directory (not a symbolic link) owned by the current user with mode exactly
 * 0700. In the root only `archives` and `approvals` may appear. In those, a
 * managed record or archive file (`<sha256>.json`) must be a regular file
 * owned by the current user with mode exactly 0600. The one exception is a
 * temp file an interrupted approval left (`.<sha256>.<pid>.<random>.tmp`),
 * which must be a regular file owned by the current user with no group or
 * other permission and is otherwise ignored. Any other entry refuses. A
 * refusal of the existing state names the path and creates or changes
 * nothing. A failure while writing (a full disk, say) can leave a directory
 * the approval created and a temp file, never a record for bytes the store
 * does not hold. The store creates what is missing with exact modes, whatever
 * the umask, and never loosens or repairs an existing entry.
 *
 * Stored archives are content-addressed, no-clobber copies whose bytes are
 * rechecked on use: an archive is published under the SHA-256 of its bytes
 * with a link that never replaces an existing file, and a copy already there
 * is reused only when its bytes still hash to its name. Nothing prevents
 * another writer with the operator's file access from changing a stored file,
 * which is why use rechecks it. A record names the digest, how it was
 * admitted (`sidecar`: the archive matched its detached digest; `legacy`: an
 * archive with no sidecar, whose digest the operator confirmed), the approval
 * time and operator, and, once revoked, the revocation time and operator.
 *
 * Approval writes a record only after the archive copy is published and read
 * back to the approved digest. So a fresh approval that fails or is
 * interrupted publishes no record, and a failed re-approval does not publish
 * a new one: a record that was already there stays as it was (and use still
 * rechecks its stored copy).
 *
 * Using an approval (loadApprovedArchive) rechecks it: the record must be
 * well formed and unrevoked, and the stored copy is read once, hashed and
 * parsed from that one buffer, and must hash to the approved digest.
 *
 * Imports refuse a path whose last component is a symbolic link, anything but
 * a regular file, and a file inside the store. Files are opened with
 * O_NOFOLLOW where the platform has it, and checked through the open
 * descriptor.
 *
 * An approval authorizes those bytes and the verdict claims in them on this
 * host until it is revoked. It does not establish where the archive came
 * from, that a past promotion decision was right, or that an archive without
 * a sidecar is unchanged since it was written.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  chmodSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fsyncDir } from "./atomic-write.js";
import { resolveHome } from "./home.js";
import { parseRestoreArchive, parseStrictJson, type RestoreArchive } from "./restore-archive.js";

/** The store's directory name under `~/.flair`. */
export const APPROVAL_STORE_DIRNAME = "approved-archives";

/** `~/.flair/approved-archives`, resolved at call time. */
export function defaultApprovalStoreRoot(home: string = resolveHome()): string {
  return join(home, ".flair", APPROVAL_STORE_DIRNAME);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RECORD_VERSION = 1;
const RECORD_KEYS = ["version", "sha256", "admission", "approvedAt", "approvedBy", "archiveName", "size", "revokedAt", "revokedBy"] as const;

export type ApprovalAdmission = "sidecar" | "legacy";

export interface ApprovalRecord {
  readonly version: typeof RECORD_VERSION;
  /** SHA-256 of the approved archive bytes, lowercase hex. */
  readonly sha256: string;
  readonly admission: ApprovalAdmission;
  readonly approvedAt: string;
  readonly approvedBy: string;
  /** The archive's file name when it was approved; informational. */
  readonly archiveName: string;
  /** The approved archive's length in bytes. */
  readonly size: number;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
}

export type ApprovalStoreErrorCode =
  | "store-unsafe"
  | "import-unsafe"
  | "import-unreadable"
  | "record-invalid"
  | "stored-mismatch"
  | "not-approved"
  | "already-revoked"
  | "invalid-digest";

/** A refusal from the store, with a message naming the path and what did not hold. */
export class ApprovalStoreError extends Error {
  readonly code: ApprovalStoreErrorCode;
  constructor(code: ApprovalStoreErrorCode, message: string) {
    super(message);
    this.name = "ApprovalStoreError";
    this.code = code;
  }
}

/** The approval publication steps, in order. */
export const APPROVAL_PUBLISH_STEPS = Object.freeze([
  "open-store",
  "stage-archive",
  "publish-archive",
  "verify-archive",
  "stage-record",
  "publish-record",
] as const);

export type ApprovalPublishStep = (typeof APPROVAL_PUBLISH_STEPS)[number];

export interface ApprovalStoreOptions {
  /** The store root; tests pass a temp directory. Defaults to defaultApprovalStoreRoot(). */
  root?: string;
  /** The uid every store entry must belong to; defaults to the current process's. Tests use it to model another owner. */
  uid?: number;
}

export interface ApprovalPublishHooks {
  /** Called immediately before each step; a test throws to fail it or ends the process to crash at it. */
  beforeStep?: (step: ApprovalPublishStep) => void;
}

// ─── File-system checks ──────────────────────────────────────────────────────

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

function currentUid(options: ApprovalStoreOptions): number | undefined {
  if (options.uid !== undefined) return options.uid;
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function storeUnsafe(message: string): ApprovalStoreError {
  return new ApprovalStoreError("store-unsafe", message);
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : undefined;
}

function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/** Refuse unless `st` (from lstat) is a real directory owned by `uid` with mode 0700. */
function checkPrivateDirectory(path: string, st: Stats, uid: number | undefined): void {
  if (st.isSymbolicLink()) throw storeUnsafe(`approval store directory ${path} is a symbolic link; the store refuses it`);
  if (!st.isDirectory()) throw storeUnsafe(`approval store path ${path} is not a directory; the store refuses it`);
  if (uid !== undefined && st.uid !== uid) {
    throw storeUnsafe(`approval store directory ${path} is owned by uid ${st.uid}, not the current user (uid ${uid}); the store refuses it`);
  }
  if ((st.mode & 0o777) !== 0o700) {
    throw storeUnsafe(
      `approval store directory ${path} has mode ${modeText(st.mode)}, not 700; the store refuses it. ` +
        "If nothing else could have written to it, run chmod 700 on it and check its contents",
    );
  }
}

/** Refuse unless `st` (from fstat of an open file) is a regular file owned by `uid` with mode 0600. */
function checkPrivateFile(path: string, st: Stats, uid: number | undefined): void {
  if (!st.isFile()) throw storeUnsafe(`approval store file ${path} is not a regular file; the store refuses it`);
  if (uid !== undefined && st.uid !== uid) {
    throw storeUnsafe(`approval store file ${path} is owned by uid ${st.uid}, not the current user (uid ${uid}); the store refuses it`);
  }
  if ((st.mode & 0o777) !== 0o600) {
    throw storeUnsafe(`approval store file ${path} has mode ${modeText(st.mode)}, not 600; the store refuses it`);
  }
}

/**
 * Read a whole regular file without following a symbolic link in its last
 * component. `check` runs on the open descriptor's stat. Throws the
 * underlying error for a missing file (ENOENT) so callers can tell absence
 * from refusal.
 */
function readNoFollow(path: string, describe: string, check: (st: Stats) => void, unsafe: (message: string) => Error): Buffer {
  if (NOFOLLOW === 0) {
    // No O_NOFOLLOW on this platform: check the last component before opening.
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw unsafe(`${describe} ${path} is a symbolic link`);
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") throw unsafe(`${describe} ${path} is a symbolic link`);
    throw error;
  }
  try {
    const st = fstatSync(fd);
    check(st);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write `bytes` to a new file (no-clobber), with exactly mode 0600, and fsync it. */
function writeNewPrivateFile(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function tempPath(dir: string, name: string): string {
  return join(dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}

function removeQuietly(path: string): void {
  try { unlinkSync(path); } catch { /* best effort: it may never have been created */ }
}

// ─── Store layout ────────────────────────────────────────────────────────────

interface StorePaths {
  readonly root: string;
  readonly archives: string;
  readonly approvals: string;
}

function storePaths(options: ApprovalStoreOptions): StorePaths {
  const root = resolve(options.root ?? defaultApprovalStoreRoot());
  return { root, archives: join(root, "archives"), approvals: join(root, "approvals") };
}

/** lstat `path`, or undefined when it does not exist. */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Create `path` with mode exactly 0700 when it is missing; then require it to be a private directory. */
function ensurePrivateDirectory(path: string, uid: number | undefined): void {
  if (lstatOrUndefined(path) === undefined) {
    try {
      mkdirSync(path, { mode: 0o700 });
      // mkdir's mode is narrowed by the umask; set it exactly. The directory
      // was created by this call, so nothing else has had it at a wider mode.
      chmodSync(path, 0o700);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
  checkPrivateDirectory(path, lstatSync(path), uid);
}

const MANAGED_FILE = /^[0-9a-f]{64}\.json$/;
const TEMP_FILE = /^\.[0-9a-f]{64}\.\d+\.[0-9a-f]{8}\.tmp$/;
const ROOT_ENTRIES = new Set(["archives", "approvals"]);

/**
 * Check every entry of an existing store directory. In the root only
 * `archives` and `approvals` may appear. In those two, a managed file
 * (`<sha256>.json`) must be a regular file owned by `uid` with mode exactly
 * 0600; a temp file an interrupted approval left (`.<sha256>.<pid>.<random>.tmp`)
 * must be a regular file owned by `uid` with no group or other permission,
 * and is otherwise ignored. Any other entry refuses.
 */
function checkEntries(dir: string, isRoot: boolean, uid: number | undefined): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (isRoot) {
      if (!ROOT_ENTRIES.has(name)) throw storeUnsafe(`approval store entry ${path} is not archives or approvals; the store refuses it`);
      continue;
    }
    const managed = MANAGED_FILE.test(name);
    if (!managed && !TEMP_FILE.test(name)) {
      throw storeUnsafe(`approval store entry ${path} is not <sha256>.json or an approval's temp file; the store refuses it`);
    }
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw storeUnsafe(`approval store file ${path} is a symbolic link; the store refuses it`);
    if (managed) {
      checkPrivateFile(path, st, uid);
    } else {
      if (!st.isFile()) throw storeUnsafe(`approval store file ${path} is not a regular file; the store refuses it`);
      if (uid !== undefined && st.uid !== uid) {
        throw storeUnsafe(`approval store file ${path} is owned by uid ${st.uid}, not the current user (uid ${uid}); the store refuses it`);
      }
      if ((st.mode & 0o077) !== 0) throw storeUnsafe(`approval store file ${path} has mode ${modeText(st.mode)}, readable by others; the store refuses it`);
    }
  }
}

/**
 * Open the store. Every directory that already exists is checked, and so is
 * every entry in it (checkEntries), before anything is created; with
 * `create`, the missing directories are then created (the parent of the
 * root with mode 0700 when it is missing too). Returns undefined when the
 * store does not exist and `create` is false.
 */
function openStore(options: ApprovalStoreOptions, create: boolean): StorePaths | undefined {
  const paths = storePaths(options);
  const uid = currentUid(options);
  const rootStat = lstatOrUndefined(paths.root);
  if (rootStat === undefined && !create) return undefined;
  const existing: Array<[string, boolean]> = [];
  if (rootStat !== undefined) {
    checkPrivateDirectory(paths.root, rootStat, uid);
    existing.push([paths.root, true]);
    for (const dir of [paths.archives, paths.approvals]) {
      const sub = lstatOrUndefined(dir);
      if (sub === undefined) continue;
      checkPrivateDirectory(dir, sub, uid);
      existing.push([dir, false]);
    }
  }
  for (const [dir, isRoot] of existing) checkEntries(dir, isRoot, uid);
  if (!create) return paths;
  const parent = dirname(paths.root);
  if (lstatOrUndefined(parent) === undefined) mkdirSync(parent, { recursive: true, mode: 0o700 });
  ensurePrivateDirectory(paths.root, uid);
  ensurePrivateDirectory(paths.archives, uid);
  ensurePrivateDirectory(paths.approvals, uid);
  return paths;
}

// ─── Records ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Parse an approval record file's bytes; `sha256` is the digest its file name claims. */
export function parseApprovalRecord(bytes: Uint8Array, sha256: string): { ok: true; record: ApprovalRecord } | { ok: false; reason: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "the record is not UTF-8" };
  }
  const parsed = parseStrictJson(text);
  if (parsed.ok === false) return { ok: false, reason: `the record is not valid JSON (${parsed.reason})` };
  const value = parsed.value;
  if (!isRecord(value)) return { ok: false, reason: "the record is not a JSON object" };
  const keys = Object.keys(value).sort();
  const expected = [...RECORD_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { ok: false, reason: `the record's fields are not exactly ${RECORD_KEYS.join(", ")}` };
  }
  if (value.version !== RECORD_VERSION) return { ok: false, reason: `the record version is not ${RECORD_VERSION}` };
  if (value.sha256 !== sha256) return { ok: false, reason: "the record's sha256 does not match its file name" };
  if (value.admission !== "sidecar" && value.admission !== "legacy") return { ok: false, reason: "the record's admission is not sidecar or legacy" };
  if (!nonEmptyString(value.approvedAt) || !nonEmptyString(value.approvedBy)) {
    return { ok: false, reason: "the record has no approval time or operator" };
  }
  if (typeof value.archiveName !== "string") return { ok: false, reason: "the record's archiveName is not a string" };
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) {
    return { ok: false, reason: "the record's size is not a non-negative integer" };
  }
  const revokedAt = value.revokedAt;
  const revokedBy = value.revokedBy;
  const bothNull = revokedAt === null && revokedBy === null;
  if (!bothNull && !(nonEmptyString(revokedAt) && nonEmptyString(revokedBy))) {
    return { ok: false, reason: "the record's revokedAt and revokedBy are not both null or both set" };
  }
  return { ok: true, record: value as unknown as ApprovalRecord };
}

function serializeRecord(record: ApprovalRecord): Buffer {
  const ordered = Object.fromEntries(RECORD_KEYS.map((key) => [key, record[key]]));
  return Buffer.from(JSON.stringify(ordered, null, 2) + "\n", "utf-8");
}

function requireDigest(sha256: string): void {
  if (!SHA256_HEX.test(sha256)) throw new ApprovalStoreError("invalid-digest", `${JSON.stringify(sha256)} is not a lowercase hex SHA-256 digest`);
}

/** Read and check a record; undefined when it does not exist. */
function readRecord(paths: StorePaths, sha256: string, uid: number | undefined): ApprovalRecord | undefined {
  const path = join(paths.approvals, `${sha256}.json`);
  let bytes: Buffer;
  try {
    bytes = readNoFollow(path, "approval record", (st) => checkPrivateFile(path, st, uid), storeUnsafe);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const parsed = parseApprovalRecord(bytes, sha256);
  if (parsed.ok === false) {
    throw new ApprovalStoreError("record-invalid", `approval record ${path} is invalid (${parsed.reason}); the store refuses it`);
  }
  return parsed.record;
}

/** Atomically replace (or create) a record: stage, fsync, rename, fsync the directory. */
function writeRecord(paths: StorePaths, record: ApprovalRecord, step: (s: ApprovalPublishStep) => void): void {
  const final = join(paths.approvals, `${record.sha256}.json`);
  step("stage-record");
  const staged = tempPath(paths.approvals, record.sha256);
  try {
    writeNewPrivateFile(staged, serializeRecord(record));
    step("publish-record");
    renameSync(staged, final);
  } catch (error) {
    removeQuietly(staged);
    throw error;
  }
  fsyncDir(paths.approvals);
}

// ─── Stored archives ─────────────────────────────────────────────────────────

/** Read the stored copy of `sha256` once; undefined when it does not exist. */
function readStoredArchive(paths: StorePaths, sha256: string, uid: number | undefined): Buffer | undefined {
  const path = join(paths.archives, `${sha256}.json`);
  try {
    return readNoFollow(path, "stored archive", (st) => checkPrivateFile(path, st, uid), storeUnsafe);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// ─── Import ──────────────────────────────────────────────────────────────────

/**
 * Read a file the operator names for import, once. Refuses a symbolic link in
 * the last path component, anything but a regular file, and a file inside the
 * store. Throws the underlying error (ENOENT included) for an unreadable path.
 */
export function readImportFile(path: string, describe: string, options: ApprovalStoreOptions = {}): Buffer {
  const importUnsafe = (message: string) => new ApprovalStoreError("import-unsafe", `refusing to import ${message}`);
  const bytes = readNoFollow(path, describe, (st) => {
    if (!st.isFile()) throw importUnsafe(`${describe} ${path}: it is not a regular file`);
  }, (message) => importUnsafe(message));
  const root = storePaths(options).root;
  let real: string;
  let realRoot: string | undefined;
  try {
    real = realpathSync(path);
    realRoot = lstatOrUndefined(root) === undefined ? undefined : realpathSync(root);
  } catch (error) {
    throw new ApprovalStoreError("import-unreadable", `cannot resolve ${describe} ${path} (${errnoCode(error) ?? "error"})`);
  }
  if (realRoot !== undefined && (real === realRoot || real.startsWith(realRoot + sep))) {
    throw importUnsafe(`${describe} ${path}: it is inside the approval store`);
  }
  return bytes;
}

// ─── Approval ────────────────────────────────────────────────────────────────

function changedStoredCopy(paths: StorePaths, sha256: string): ApprovalStoreError {
  return new ApprovalStoreError(
    "stored-mismatch",
    `stored archive ${join(paths.archives, `${sha256}.json`)} no longer hashes to ${sha256}; the store refuses to reuse it. ` +
      "Move it out of the store and approve the archive again",
  );
}

export interface ApproveArchiveInput {
  /** The archive's exact bytes, as read once by the caller. */
  readonly bytes: Uint8Array;
  /** The digest the caller verified for `bytes`; recomputed here and required to match. */
  readonly sha256: string;
  readonly admission: ApprovalAdmission;
  readonly operator: string;
  readonly archiveName: string;
  /** The approval time; defaults to now. */
  readonly now?: string;
}

/**
 * Record an approval: check the store as it stands, create any missing
 * directory, publish the archive bytes under their digest (reusing a stored
 * copy that still hashes to it), read them back, then publish the record.
 * Replaces an existing record for the digest, revoked or not. Throws an
 * ApprovalStoreError (or the underlying I/O error) when approval does not
 * complete. A refusal of the existing state (an unsafe directory or entry,
 * an invalid record, a stored copy that no longer hashes to its name) comes
 * before anything is created. No record is written or changed before the
 * stored copy is verified, so a failure leaves any existing record as it was.
 */
export function approveArchive(input: ApproveArchiveInput, options: ApprovalStoreOptions = {}, hooks: ApprovalPublishHooks = {}): ApprovalRecord {
  const step = hooks.beforeStep ?? (() => {});
  requireDigest(input.sha256);
  if (sha256Of(input.bytes) !== input.sha256) {
    throw new ApprovalStoreError("stored-mismatch", "the archive bytes do not hash to the digest being approved; nothing was stored");
  }
  if (!nonEmptyString(input.operator)) throw new ApprovalStoreError("record-invalid", "an approval needs a non-empty operator name");
  const uid = currentUid(options);

  step("open-store");
  // Check the store as it stands (its directories, every entry, this
  // digest's record and its stored copy) before creating any missing
  // directory, so a refusal of existing state creates nothing.
  const found = openStore(options, false);
  if (found !== undefined) {
    readRecord(found, input.sha256, uid);
    const prior = readStoredArchive(found, input.sha256, uid);
    if (prior !== undefined && sha256Of(prior) !== input.sha256) throw changedStoredCopy(found, input.sha256);
  }
  const paths = openStore(options, true)!;

  const final = join(paths.archives, `${input.sha256}.json`);
  const existing = readStoredArchive(paths, input.sha256, uid);
  if (existing !== undefined && sha256Of(existing) !== input.sha256) throw changedStoredCopy(paths, input.sha256);
  if (existing === undefined) {
    step("stage-archive");
    const staged = tempPath(paths.archives, input.sha256);
    try {
      writeNewPrivateFile(staged, input.bytes);
      step("publish-archive");
      // No-clobber: a stored archive is never replaced.
      linkSync(staged, final);
    } catch (error) {
      removeQuietly(staged);
      if (errnoCode(error) === "EEXIST") {
        throw new ApprovalStoreError("stored-mismatch", `stored archive ${final} appeared while approving; run the approval again`);
      }
      throw error;
    }
    removeQuietly(staged);
    fsyncDir(paths.archives);
  }

  step("verify-archive");
  const stored = readStoredArchive(paths, input.sha256, uid);
  if (stored === undefined || sha256Of(stored) !== input.sha256) {
    throw new ApprovalStoreError("stored-mismatch", `stored archive ${final} does not read back to ${input.sha256}; no approval was recorded`);
  }

  const record: ApprovalRecord = {
    version: RECORD_VERSION,
    sha256: input.sha256,
    admission: input.admission,
    approvedAt: input.now ?? new Date().toISOString(),
    approvedBy: input.operator,
    archiveName: input.archiveName,
    size: stored.length,
    revokedAt: null,
    revokedBy: null,
  };
  writeRecord(paths, record, step);
  return record;
}

/** Revoke the approval of `sha256`. Throws when there is none or it is already revoked. */
export function revokeApproval(sha256: string, operator: string, options: ApprovalStoreOptions = {}, now?: string): ApprovalRecord {
  requireDigest(sha256);
  if (!nonEmptyString(operator)) throw new ApprovalStoreError("record-invalid", "a revocation needs a non-empty operator name");
  const uid = currentUid(options);
  const paths = openStore(options, false);
  const record = paths === undefined ? undefined : readRecord(paths, sha256, uid);
  if (paths === undefined || record === undefined) {
    throw new ApprovalStoreError("not-approved", `no approval of ${sha256} exists on this host`);
  }
  if (record.revokedAt !== null) {
    throw new ApprovalStoreError("already-revoked", `the approval of ${sha256} was already revoked at ${record.revokedAt} by ${record.revokedBy}`);
  }
  const revoked: ApprovalRecord = { ...record, revokedAt: now ?? new Date().toISOString(), revokedBy: operator };
  writeRecord(paths, revoked, () => {});
  return revoked;
}

export type StoredCopyState = "intact" | "missing" | "does-not-match" | "unsafe";

export interface ListedApproval {
  readonly record: ApprovalRecord;
  /** Whether the stored copy still exists, is safe, and hashes to the record's digest. */
  readonly stored: StoredCopyState;
}

/** Every approval record, sorted by approval time, each with its stored copy checked. */
export function listApprovals(options: ApprovalStoreOptions = {}): ListedApproval[] {
  const uid = currentUid(options);
  const paths = openStore(options, false);
  if (paths === undefined || lstatOrUndefined(paths.approvals) === undefined) return [];
  const listed: ListedApproval[] = [];
  for (const name of readdirSync(paths.approvals).sort()) {
    // A temp file an interrupted approval left; openStore already checked it.
    if (TEMP_FILE.test(name)) continue;
    const sha256 = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!SHA256_HEX.test(sha256)) {
      throw storeUnsafe(`approval store entry ${join(paths.approvals, name)} is not <sha256>.json; the store refuses it`);
    }
    const record = readRecord(paths, sha256, uid)!;
    let stored: StoredCopyState;
    try {
      const bytes = readStoredArchive(paths, sha256, uid);
      stored = bytes === undefined ? "missing" : sha256Of(bytes) === sha256 ? "intact" : "does-not-match";
    } catch (error) {
      if (!(error instanceof ApprovalStoreError)) throw error;
      stored = "unsafe";
    }
    listed.push({ record, stored });
  }
  return listed.sort((a, b) => a.record.approvedAt.localeCompare(b.record.approvedAt) || a.record.sha256.localeCompare(b.record.sha256));
}

// ─── Use ─────────────────────────────────────────────────────────────────────

export type ApprovedArchiveRefusalCode =
  | "not-approved"
  | "revoked"
  | "stored-missing"
  | "stored-mismatch"
  | "archive-refused"
  | "store-unsafe"
  | "record-invalid";

export type ApprovedArchiveResult =
  | { readonly ok: true; readonly record: ApprovalRecord; readonly archive: RestoreArchive; readonly sha256: string }
  | { readonly ok: false; readonly code: ApprovedArchiveRefusalCode; readonly reason: string; readonly record?: ApprovalRecord };

/**
 * Load the approved bytes for `sha256` and recheck them: the record must
 * exist, be well formed and be unrevoked; the stored copy is read once, and
 * that one buffer must hash to `sha256` and parse as a restorable archive.
 * Never creates or changes anything.
 */
export function loadApprovedArchive(sha256: string, options: ApprovalStoreOptions = {}): ApprovedArchiveResult {
  if (!SHA256_HEX.test(sha256)) return { ok: false, code: "not-approved", reason: `${sha256} is not a SHA-256 digest` };
  const uid = currentUid(options);
  let paths: StorePaths | undefined;
  let record: ApprovalRecord | undefined;
  try {
    paths = openStore(options, false);
    record = paths === undefined ? undefined : readRecord(paths, sha256, uid);
  } catch (error) {
    if (!(error instanceof ApprovalStoreError)) throw error;
    return { ok: false, code: error.code === "record-invalid" ? "record-invalid" : "store-unsafe", reason: error.message };
  }
  if (paths === undefined || record === undefined) {
    return { ok: false, code: "not-approved", reason: `no approval of ${sha256} exists on this host` };
  }
  if (record.revokedAt !== null) {
    return { ok: false, code: "revoked", record, reason: `the approval of ${sha256} on this host was revoked at ${record.revokedAt} by ${record.revokedBy}` };
  }
  const path = join(paths.archives, `${sha256}.json`);
  let bytes: Buffer | undefined;
  try {
    bytes = readStoredArchive(paths, sha256, uid);
  } catch (error) {
    if (!(error instanceof ApprovalStoreError)) throw error;
    return { ok: false, code: "store-unsafe", record, reason: error.message };
  }
  if (bytes === undefined) {
    return { ok: false, code: "stored-missing", record, reason: `the approved copy ${path} is missing` };
  }
  const parsed = parseRestoreArchive(bytes);
  if (parsed.sha256 !== sha256) {
    return { ok: false, code: "stored-mismatch", record, reason: `the approved copy ${path} no longer hashes to ${sha256} (it hashes to ${parsed.sha256})` };
  }
  if (parsed.ok === false) {
    return { ok: false, code: "archive-refused", record, reason: `the approved copy ${path} is not a restorable archive (${parsed.reason})` };
  }
  return { ok: true, record, archive: parsed.archive, sha256 };
}
