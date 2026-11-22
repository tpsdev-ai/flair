/**
 * backup-artifact.ts — a `flair backup` archive and its detached SHA-256
 * digest, published and read as one artifact (flair#2664 slice 1b).
 *
 * The artifact is two files: the archive at the output path, and a sidecar at
 * `<archive>.sha256` that records the SHA-256 of the archive's exact bytes in
 * the `sha256sum` line format, `<64 lowercase hex>  <archive file name>\n`.
 * From the archive's directory, `shasum -a 256 -c` and GNU `sha256sum -c`
 * check it. A file name holding a backslash, line feed or carriage return is
 * escaped the way GNU coreutils 9 escapes it: the line starts with `\` and
 * those characters are written as `\\`, `\n` and `\r`. Perl `shasum` reads the
 * backslash and line-feed escapes but not `\r`; the BSD `sha256sum` that ships
 * with macOS reads only unescaped lines. Restore checks the digest, the line
 * framing, the escaping and that the name is UTF-8 (as the formatter writes
 * it), and does not compare the name with the archive's file name, so a pair
 * renamed together still verifies.
 *
 * The sidecar detects a damaged, truncated or substituted archive and an
 * archive paired with another backup's digest. It is not an authenticity
 * check: anyone who can write both files can write a matching pair.
 *
 * PUBLICATION (publishBackupArtifact). Both files are staged in a new
 * directory beside the output path (the same filesystem, so each rename is
 * atomic), then published in this order:
 *
 *   1. stage-archive      write the serialized archive to the staging directory
 *   2. sync-archive       fsync it
 *   3. verify-archive     read it back once; the caller's checks run on that
 *                         text, the bytes must equal the serialized bytes, and
 *                         the digest is the SHA-256 of those bytes
 *   4. stage-digest       write and fsync the sidecar in the staging directory
 *   5. remove-old-digest  remove any sidecar already at `<output>.sha256`
 *   6. publish-archive    rename the staged archive over the output path
 *   7. publish-digest     rename the staged sidecar to `<output>.sha256`
 *
 * The directory is fsynced after steps 5, 6 and 7. Steps 1–4 touch only the
 * staging directory. Step 5 removes the old digest before the archive can
 * change, and step 7 publishes the new digest only after the new archive is in
 * place. With one backup writing the output path, and starting from no files,
 * a consistent pair, an archive with no sidecar, or a sidecar with no archive,
 * a crash at any point leaves one of: the starting state (steps 1–5), the
 * previous archive with no sidecar or no files (step 6), the new archive with
 * no sidecar (step 7), or the new pair. Only the fourth starting state is
 * inconsistent, and step 5 removes its sidecar before anything is published.
 * A sidecar this backup writes never sits beside bytes it does not describe,
 * and restore refuses an archive with no sidecar unless this host holds a
 * valid approval for those exact bytes. A process crash needs no
 * fsync for this, because each step is one rename or unlink applied in order.
 * Surviving power loss in this order relies on the directory fsync, which is
 * best-effort (atomic-write.ts fsyncDir): on a filesystem that cannot fsync a
 * directory, the order is not guaranteed to survive power loss.
 *
 * Two backups writing the same output path at once are not serialized. They
 * can leave an archive beside the other backup's sidecar (one publishes its
 * pair, then the other replaces the archive and stops before publishing its
 * digest); restore refuses such a pair as a digest mismatch.
 *
 * The staging directory is removed after publication and after a failure.
 * That removal is an attempt that can fail: a failure is reported (as
 * `stagingLeft` on success, appended to the error on failure) and does not
 * change what the result says about the published names.
 *
 * READING (readBackupArtifact). The archive is read once. parseRestoreArchive
 * (restore-archive.ts) hashes that buffer and parses the same buffer. The
 * sidecar is read once and its digest must equal that hash; only then is the
 * parse result considered. Nothing here writes anything. Every refusal names
 * the file and what did not hold and gives a remedy that does not assume
 * which file is at fault. By default it also says restore stopped before any
 * write; a caller that is not restore (`flair backup-approval approve`)
 * passes its own clause. A missing sidecar is one whose path does not exist
 * at all: a symbolic link at the sidecar path whose target is missing is
 * refused as unreadable, never treated as missing.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fsyncDir } from "./atomic-write.js";
import { parseRestoreArchive, type RestoreArchive, type RestoreArchiveRefusal } from "./restore-archive.js";

/** The sidecar's file name is the archive's file name plus this suffix. */
export const BACKUP_DIGEST_SUFFIX = ".sha256";

/** Where the digest sidecar for `archivePath` lives. */
export function backupDigestPath(archivePath: string): string {
  return `${archivePath}${BACKUP_DIGEST_SUFFIX}`;
}

// ─── Sidecar format ──────────────────────────────────────────────────────────

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DIGEST_LINE = /^(\\?)([0-9a-f]{64}) {2}([^\n\r]+)\n$/;
/** An escaped name: only `\\`, `\n` and `\r` escapes, and at least one of them. */
const ESCAPED_NAME = /^(?:[^\\]|\\[\\nr])+$/;
const ESCAPE_SEQUENCE = /\\[\\nr]/;

/** The sidecar text for an archive named `archiveName` whose bytes hash to `sha256`. */
export function formatBackupDigest(sha256: string, archiveName: string): string {
  if (!SHA256_HEX.test(sha256)) throw new TypeError("formatBackupDigest: expected a lowercase hex SHA-256 digest");
  if (archiveName.length === 0) throw new TypeError("formatBackupDigest: expected a non-empty archive file name");
  if (!/[\\\n\r]/.test(archiveName)) return `${sha256}  ${archiveName}\n`;
  const escaped = archiveName.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `\\${sha256}  ${escaped}\n`;
}

export type BackupDigestParse =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a sidecar's digest. Accepts exactly one line in the format
 * formatBackupDigest writes: 64 lowercase hex characters, two spaces, a
 * non-empty name in UTF-8, and one trailing line feed. A name written without
 * escapes holds no backslash; a name written with escapes follows a leading
 * `\`, uses only `\\`, `\n` and `\r`, and holds at least one of them. Anything
 * else is refused with a reason. The name is not compared with any file name.
 */
export function parseBackupDigest(bytes: Uint8Array): BackupDigestParse {
  // latin1 maps each byte to one character, so the check is over the bytes
  // themselves whatever encoding the name is in. No byte of a multi-byte
  // UTF-8 sequence is 0x5c, so a backslash here is a backslash in the name.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const match = DIGEST_LINE.exec(text);
  if (match) {
    const [, marker, sha256, name] = match;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name!, "latin1"));
    } catch {
      return { ok: false, reason: "the file name is not UTF-8" };
    }
    if (marker === "") {
      if (name!.includes("\\")) {
        return { ok: false, reason: "the file name holds a backslash, but the line does not start with the escape marker \\" };
      }
      return { ok: true, sha256: sha256! };
    }
    if (!ESCAPED_NAME.test(name!) || !ESCAPE_SEQUENCE.test(name!)) {
      return { ok: false, reason: "the line starts with the escape marker \\, but the file name is not escaped as \\\\, \\n and \\r" };
    }
    return { ok: true, sha256: sha256! };
  }
  if (text.length === 0) return { ok: false, reason: "the file is empty" };
  if (!text.endsWith("\n")) return { ok: false, reason: "the line does not end with a line feed" };
  if (text.indexOf("\n") !== text.length - 1) return { ok: false, reason: "the file holds more than one line" };
  return { ok: false, reason: "expected 64 lowercase hex characters, two spaces and the archive file name" };
}

// ─── Publication ─────────────────────────────────────────────────────────────

/** The publication steps, in order (see the module comment). */
export const BACKUP_PUBLISH_STEPS = Object.freeze([
  "stage-archive",
  "sync-archive",
  "verify-archive",
  "stage-digest",
  "remove-old-digest",
  "publish-archive",
  "publish-digest",
] as const);

export type BackupPublishStep = (typeof BACKUP_PUBLISH_STEPS)[number];

export interface BackupPublishHooks {
  /**
   * Called immediately before each step. A test throws here to fail that
   * step, or ends the process here to crash at it.
   */
  beforeStep?: (step: BackupPublishStep) => void;
  /** Removes the staging directory; tests replace it to make the removal fail. */
  removeDir?: (path: string) => void;
}

export interface BackupPublishOptions {
  /** The archive's published path; the sidecar goes to `<outputPath>.sha256`. */
  outputPath: string;
  /** The archive text. It is written as UTF-8, and those bytes are what the digest covers. */
  serialized: string;
  /** Checks the staged archive's text, as read back, before anything is published. Throw to refuse. */
  verify?: (written: string) => void;
}

export interface BackupPublishResult {
  /** SHA-256 of the published archive bytes, lowercase hex. */
  readonly sha256: string;
  readonly digestPath: string;
  /** Set when the pair was published but the staging directory could not be removed. */
  readonly stagingLeft?: { readonly path: string; readonly reason: string };
}

/** fsync a regular file through its own descriptor. */
function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Try to remove the staging directory; the reason it could not be removed, or undefined. */
function removeStagingDir(path: string | undefined, removeDir: (path: string) => void): string | undefined {
  if (path === undefined) return undefined;
  try {
    removeDir(path);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code ?? errorMessage(error);
  }
}

/**
 * Publish `serialized` at `outputPath` together with its digest sidecar, in
 * the order the module comment gives. Throws when publication does not
 * complete; the message says what the published names hold. Then, on success
 * and on failure, it tries to remove the staging directory and reports a
 * removal that fails (see the module comment).
 */
export function publishBackupArtifact(options: BackupPublishOptions, hooks: BackupPublishHooks = {}): BackupPublishResult {
  const { outputPath, serialized } = options;
  const step = hooks.beforeStep ?? (() => {});
  const removeDir = hooks.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const dir = dirname(outputPath);
  const digestPath = backupDigestPath(outputPath);
  const expected = Buffer.from(serialized, "utf-8");
  let stagingDir: string | undefined;
  let removedOldDigest = false;
  let publishedArchive = false;
  let published: { sha256: string; digestPath: string };
  try {
    step("stage-archive");
    mkdirSync(dir, { recursive: true });
    stagingDir = mkdtempSync(join(dir, ".flair-backup-"));
    const stagedArchive = join(stagingDir, "archive.json");
    writeFileSync(stagedArchive, serialized, { encoding: "utf-8", flag: "wx", mode: 0o600 });

    step("sync-archive");
    fsyncFile(stagedArchive);

    step("verify-archive");
    const written = readFileSync(stagedArchive);
    options.verify?.(written.toString("utf-8"));
    if (!Buffer.isBuffer(written) || !written.equals(expected)) {
      throw new Error("archive bytes on disk do not match the serialized archive");
    }
    const sha256 = createHash("sha256").update(written).digest("hex");

    step("stage-digest");
    const stagedDigest = join(stagingDir, `archive.json${BACKUP_DIGEST_SUFFIX}`);
    writeFileSync(stagedDigest, formatBackupDigest(sha256, basename(outputPath)), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    fsyncFile(stagedDigest);

    step("remove-old-digest");
    try {
      unlinkSync(digestPath);
      removedOldDigest = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    fsyncDir(dir);

    step("publish-archive");
    renameSync(stagedArchive, outputPath);
    publishedArchive = true;
    fsyncDir(dir);

    step("publish-digest");
    renameSync(stagedDigest, digestPath);
    fsyncDir(dir);
    published = { sha256, digestPath };
  } catch (error) {
    const cause = errorMessage(error);
    const state = publishedArchive
      ? `${outputPath} holds the new archive but its digest sidecar ${digestPath} was not written, ` +
        "and restore refuses the archive without it unless this host holds a valid approval for these exact bytes; run the backup again"
      : removedOldDigest
        ? `the previous digest sidecar ${digestPath} was removed and ${outputPath} was not replaced, ` +
          "so a previous archive there no longer has a sidecar"
        : "nothing was published";
    const left = removeStagingDir(stagingDir, removeDir);
    const cleanup = left === undefined ? "" : `; the staging directory ${stagingDir} could not be removed (${left}): remove it by hand`;
    throw new Error(`${cause}; ${state}${cleanup}`, { cause: error });
  }
  const left = removeStagingDir(stagingDir, removeDir);
  return left === undefined ? published : { ...published, stagingLeft: { path: stagingDir!, reason: left } };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export type BackupArtifactRefusalCode =
  | "archive-unreadable"
  | "digest-missing"
  | "digest-unreadable"
  | "digest-invalid"
  | "digest-mismatch"
  | "archive-refused";

export interface VerifiedBackupArtifact {
  readonly ok: true;
  readonly archive: RestoreArchive;
  /** SHA-256 of the archive bytes that were parsed, lowercase hex; equal to the sidecar's. */
  readonly sha256: string;
  readonly digestPath: string;
}

export interface BackupArtifactRefusal {
  readonly ok: false;
  readonly code: BackupArtifactRefusalCode;
  /** One sentence or more naming the files, what did not hold, and what to do. */
  readonly reason: string;
  /** SHA-256 of the archive bytes read, when the archive was read. */
  readonly sha256?: string;
  /** The parse refusal, on `archive-refused`. */
  readonly archiveRefusal?: RestoreArchiveRefusal;
}

export type BackupArtifactResult = VerifiedBackupArtifact | BackupArtifactRefusal;

export interface BackupArtifactReadHooks {
  /** Reads a whole file; tests use it to count reads or change bytes between reads. */
  readFile?: (path: string) => Buffer;
  /** What every refusal says stopped; defaults to "restore stopped before any write". */
  stopped?: string;
}

/** Whether anything, a dangling symbolic link included, exists at `path`. */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : "read failed";
}

/**
 * Verify a backup artifact before restore uses it. In order:
 *   1. read the archive's bytes once;
 *   2. hash and parse that one buffer (parseRestoreArchive);
 *   3. read the sidecar once and parse its digest line;
 *   4. require the sidecar's digest to equal the hash from step 2;
 *   5. require the parse from step 2 to have admitted the archive.
 * The first step that does not hold is returned as a named refusal.
 */
export function readBackupArtifact(archivePath: string, hooks: BackupArtifactReadHooks = {}): BackupArtifactResult {
  const readFile = hooks.readFile ?? ((path: string) => readFileSync(path));
  const digestPath = backupDigestPath(archivePath);
  const stopped = hooks.stopped ?? "restore stopped before any write";
  const putSidecar = "put the .sha256 file written with this archive beside it";

  let bytes: Buffer;
  try {
    bytes = readFile(archivePath);
  } catch (error) {
    return {
      ok: false, code: "archive-unreadable",
      reason: `cannot read archive ${archivePath} (${errnoCode(error)}); ${stopped}. Check the path and that this user can read the file.`,
    };
  }

  const parsed = parseRestoreArchive(bytes);
  const sha256 = parsed.sha256;

  let sidecar: Buffer;
  try {
    sidecar = readFile(digestPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" && lstatExists(digestPath)) {
      return {
        ok: false, code: "digest-unreadable", sha256,
        reason:
          `archive digest sidecar ${digestPath} is a symbolic link whose target does not exist; ${stopped}. ` +
          `Replace it with the .sha256 file written with this archive.`,
      };
    }
    if (errnoCode(error) === "ENOENT") {
      return {
        ok: false, code: "digest-missing", sha256,
        reason:
          `archive digest sidecar ${digestPath} not found; ${stopped}. ` +
          `flair backup writes the archive's SHA-256 to that file beside the archive: ${putSidecar}, or take a new ` +
          "backup. An archive written before flair backup published digests has no sidecar: restore admits it only " +
          `after the operator approves it on this host with flair backup-approval legacy-admit ${archivePath}.`,
      };
    }
    return {
      ok: false, code: "digest-unreadable", sha256,
      reason:
        `cannot read archive digest sidecar ${digestPath} (${errnoCode(error)}); ${stopped}. ` +
        `Check that the sidecar is a file this user can read, or ${putSidecar}.`,
    };
  }

  const recorded = parseBackupDigest(sidecar);
  if (recorded.ok === false) {
    return {
      ok: false, code: "digest-invalid", sha256,
      reason:
        `archive digest sidecar ${digestPath} is not a SHA-256 digest line (${recorded.reason}); ${stopped}. ` +
        `${putSidecar[0]!.toUpperCase()}${putSidecar.slice(1)}, or take a new backup.`,
    };
  }

  if (recorded.sha256 !== sha256) {
    return {
      ok: false, code: "digest-mismatch", sha256,
      reason:
        `archive ${archivePath} does not match its digest sidecar: its bytes hash to SHA-256 ${sha256}, ` +
        `and ${digestPath} records ${recorded.sha256}; ${stopped}. Use a copy of the archive and sidecar that ` +
        "match each other (from the archive's directory, shasum -a 256 -c checks a pair; for a file name containing a carriage return use GNU sha256sum -c), or take a new backup.",
    };
  }

  if (parsed.ok === false) {
    const location = parsed.location === "" ? "/" : parsed.location;
    return {
      ok: false, code: "archive-refused", sha256, archiveRefusal: parsed,
      reason:
        `archive ${archivePath} matches its digest sidecar but is not a restorable archive: ${parsed.reason} ` +
        `(${parsed.code} at ${location}); ${stopped}. Restore from another backup, or take a new one.`,
    };
  }

  return { ok: true, archive: parsed.archive, sha256, digestPath };
}
