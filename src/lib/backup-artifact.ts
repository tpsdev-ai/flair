/**
 * backup-artifact.ts — a `flair backup` archive and its detached SHA-256
 * digest, published and read as one artifact (flair#2664 slice 1b).
 *
 * The artifact is two files: the archive at the output path, and a sidecar at
 * `<archive>.sha256` that records the SHA-256 of the archive's exact bytes in
 * the `sha256sum` line format, `<64 lowercase hex>  <archive file name>\n`
 * (`sha256sum -c` and `shasum -a 256 -c` can check it). A file name holding a
 * backslash, line feed or carriage return is escaped the way GNU coreutils
 * escapes it: the line starts with `\` and those characters are written as
 * `\\`, `\n` and `\r`. Restore reads only the digest; the name is
 * informational, so a pair renamed together still verifies.
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
 * place. So whatever point a crash stops at, the published names hold the
 * previous pair (or the previous archive alone), the previous archive with no
 * sidecar, the new archive with no sidecar, or the new pair. A sidecar is never
 * left beside bytes it does not describe, and restore refuses an archive with
 * no sidecar. A process crash needs no fsync for this, because each step is one
 * rename or unlink applied in order. Surviving power loss in this order relies
 * on the directory fsync, which is best-effort (atomic-write.ts fsyncDir): on a
 * filesystem that cannot fsync a directory, the order is not guaranteed to
 * survive power loss. Two backups writing the same output path at once are not
 * serialized; a mismatched pair they leave is refused at restore.
 *
 * READING (readBackupArtifact). The archive is read once. parseRestoreArchive
 * (restore-archive.ts) hashes that buffer and parses the same buffer. The
 * sidecar is read once and its digest must equal that hash; only then is the
 * parse result considered. Nothing here writes anything.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const DIGEST_LINE = /^\\?([0-9a-f]{64}) {2}[^\n\r]+\n$/;

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
 * formatBackupDigest writes: an optional leading `\`, 64 lowercase hex
 * characters, two spaces, a non-empty name with no line break, and one
 * trailing line feed. Anything else is refused with a reason.
 */
export function parseBackupDigest(bytes: Uint8Array): BackupDigestParse {
  // latin1 maps each byte to one character, so the check is over the bytes
  // themselves whatever encoding the name is in.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const match = DIGEST_LINE.exec(text);
  if (match) return { ok: true, sha256: match[1]! };
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

/**
 * Publish `serialized` at `outputPath` together with its digest sidecar, in
 * the order the module comment gives. Throws when publication does not
 * complete; the message says what the published names hold. The staging
 * directory is removed on success and on any thrown failure.
 */
export function publishBackupArtifact(options: BackupPublishOptions, hooks: BackupPublishHooks = {}): BackupPublishResult {
  const { outputPath, serialized } = options;
  const step = hooks.beforeStep ?? (() => {});
  const dir = dirname(outputPath);
  const digestPath = backupDigestPath(outputPath);
  const expected = Buffer.from(serialized, "utf-8");
  let stagingDir: string | undefined;
  let removedOldDigest = false;
  let publishedArchive = false;
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
    return { sha256, digestPath };
  } catch (error) {
    const cause = errorMessage(error);
    if (publishedArchive) {
      throw new Error(
        `${cause}; ${outputPath} holds the new archive but its digest sidecar ${digestPath} was not written, ` +
          "and restore refuses the archive without it; run the backup again",
        { cause: error },
      );
    }
    if (removedOldDigest) {
      throw new Error(
        `${cause}; the previous digest sidecar ${digestPath} was removed and ${outputPath} was not replaced, ` +
          "so a previous archive there no longer has a sidecar",
        { cause: error },
      );
    }
    throw new Error(`${cause}; nothing was published`, { cause: error });
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
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
  const sidecarHint = "restore refuses it before any write";

  let bytes: Buffer;
  try {
    bytes = readFile(archivePath);
  } catch (error) {
    return { ok: false, code: "archive-unreadable", reason: `cannot read archive ${archivePath} (${errnoCode(error)})` };
  }

  const parsed = parseRestoreArchive(bytes);
  const sha256 = parsed.sha256;

  let sidecar: Buffer;
  try {
    sidecar = readFile(digestPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return {
        ok: false, code: "digest-missing", sha256,
        reason:
          `archive digest sidecar ${digestPath} not found; ${sidecarHint}. ` +
          "flair backup writes the archive's SHA-256 to that file beside the archive: copy the .sha256 file written " +
          "with this archive next to it, or take a new backup. An archive written before flair backup published " +
          "digests has no sidecar, and restore refuses it (flair#2664).",
      };
    }
    return {
      ok: false, code: "digest-unreadable", sha256,
      reason: `cannot read archive digest sidecar ${digestPath} (${errnoCode(error)}); ${sidecarHint}`,
    };
  }

  const recorded = parseBackupDigest(sidecar);
  if (recorded.ok === false) {
    return {
      ok: false, code: "digest-invalid", sha256,
      reason:
        `archive digest sidecar ${digestPath} is not a SHA-256 digest line (${recorded.reason}); ${sidecarHint}. ` +
        "Restore the sidecar flair backup wrote with this archive.",
    };
  }

  if (recorded.sha256 !== sha256) {
    return {
      ok: false, code: "digest-mismatch", sha256,
      reason:
        `archive ${archivePath} does not match its digest sidecar: its bytes hash to SHA-256 ${sha256}, ` +
        `and ${digestPath} records ${recorded.sha256}; ${sidecarHint}. The archive or its sidecar changed after ` +
        "flair backup wrote them: use an intact copy of both files.",
    };
  }

  if (parsed.ok === false) {
    const location = parsed.location === "" ? "/" : parsed.location;
    return {
      ok: false, code: "archive-refused", sha256, archiveRefusal: parsed,
      reason: `archive ${archivePath} refused: ${parsed.reason} (${parsed.code} at ${location}); ${sidecarHint}`,
    };
  }

  return { ok: true, archive: parsed.archive, sha256, digestPath };
}
