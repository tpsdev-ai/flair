/**
 * agent-key-file.ts — the shared agent private-key file helper for the five
 * provisioning paths (flair#3077 slice A): `flair agent add`, local
 * `flair init --agent/--agent-id`, remote `flair init --target ... --agent-id`,
 * `flair principal add`, and `flair import`. `flair agent rotate-key` and
 * `flair mcp grant` still write key files themselves (slice B).
 *
 * POSIX policy:
 *   - the keys directory is created 0700; an existing directory owned by the
 *     current user is tightened to 0700 when it has group or world bits, with
 *     one notice line; a symlink, a non-directory, or a directory owned by
 *     another user is refused.
 *   - a new key is written to a unique temp file in the keys directory
 *     (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600), fsynced, then published with a
 *     hard link at the final path, so an occupied path is never overwritten.
 *   - an existing key is checked on the OPENED DESCRIPTOR: a regular file,
 *     owned by the current user, with no group/world bits. It is read and left
 *     untouched; a file with group or world bits is refused before its bytes
 *     are read.
 *
 * win32: mode bits do not establish owner-only there; the create path sets the
 * mode and the reuse path neither checks nor sets it.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** A refusal is operator-facing: the caller prints the message and exits 1. */
export class AgentKeyFileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyFileRefusal";
  }
}

/** Test hooks; production leaves these unset. */
export interface AgentKeyFileTestHooks {
  /** Runs with the created key's descriptor before the first byte is written. */
  beforeFirstWrite?: (fd: number) => void;
  /** Replaces the seed write and returns the byte count a real write would. */
  writeSeedFile?: (fd: number, bytes: Buffer) => number;
  /** Runs after the keys directory is created, before anything else touches it. */
  afterKeysDirCreate?: (dir: string) => void;
  /** Runs with the opened key descriptor immediately before its bytes are read. */
  beforeKeyRead?: (fd: number) => void;
  /** Runs after the temp key is complete and before it is linked into place. */
  beforePublish?: (tempPath: string, finalPath: string) => void;
}

let testHooks: AgentKeyFileTestHooks | undefined;

export function setAgentKeyFileTestHooks(hooks: AgentKeyFileTestHooks | undefined): void {
  testHooks = hooks;
}

export interface AgentKeyFileContents {
  /** The raw bytes stored in (or read from) the key file. */
  bytes: Uint8Array;
  /** True when this call created the file. */
  created: boolean;
}

const WIN32 = process.platform === "win32";
const NOFOLLOW = WIN32 ? 0 : constants.O_NOFOLLOW;
const O_NONBLOCK = WIN32 ? 0 : constants.O_NONBLOCK;

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Create `keysDir` 0700 when missing; tighten an existing directory the
 * current user owns; refuse a symlink, a non-directory, or another owner.
 */
export function ensureAgentKeysDir(keysDir: string): void {
  if (WIN32) {
    mkdirSync(keysDir, { recursive: true });
    return;
  }

  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(keysDir);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    // The directory is owner-only from creation: the umask can only narrow the
    // mode, never widen it past 0700. No later chmod is involved.
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    testHooks?.afterKeysDirCreate?.(keysDir);
    return;
  }

  if (st.isSymbolicLink()) {
    throw new AgentKeyFileRefusal(
      `keys directory ${keysDir} is a symlink; replace it with a real directory you own (mode 700)`,
    );
  }
  if (!st.isDirectory()) {
    throw new AgentKeyFileRefusal(
      `keys directory ${keysDir} is not a directory; move it aside and run again so flair can create a directory (mode 700)`,
    );
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new AgentKeyFileRefusal(
      `keys directory ${keysDir} is not owned by the current user; move it aside and run again so flair can create a directory (mode 700)`,
    );
  }
  if ((st.mode & 0o077) !== 0) {
    chmodSync(keysDir, 0o700);
    console.log(`Keys directory ${keysDir} was accessible to other users; permissions tightened to 0700.`);
  }
}

/**
 * Read an existing key, or return null when the path does not exist. On POSIX,
 * check the opened descriptor and refuse symlinks. Windows reads by path.
 */
export function readExistingAgentKey(privateKeyPath: string): Uint8Array | null {
  if (WIN32) {
    try {
      return new Uint8Array(readFileSync(privateKeyPath));
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  // O_NOFOLLOW covers the last component; lstat gives the clearer refusal for
  // a link that was already there when the command started.
  try {
    if (lstatSync(privateKeyPath).isSymbolicLink()) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is a symlink; remove it and run again so flair can create a new owner-only key`,
      );
    }
  } catch (error) {
    if (error instanceof AgentKeyFileRefusal) throw error;
    if (errnoCode(error) !== "ENOENT") throw error;
    return null;
  }

  let fd: number;
  try {
    fd = openSync(privateKeyPath, constants.O_RDONLY | NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is a symlink; remove it and run again so flair can create a new owner-only key`,
      );
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is not a regular file; remove it and run again so flair can create a new owner-only key`,
      );
    }
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is owned by another user; move it aside and run again so flair can create a new owner-only key`,
      );
    }
    if ((st.mode & 0o077) !== 0) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is accessible to other users (mode ${modeText(st.mode)}); ` +
          `run chmod 600 ${privateKeyPath} to make it owner-only`,
      );
    }
    testHooks?.beforeKeyRead?.(fd);
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/**
 * Create a new key file at 0600 from the first byte, refusing to replace an
 * existing path. The bytes go to a unique temp file in the same directory and
 * are published with a hard link, so an occupied path is never overwritten.
 * A temp name that is already taken is retried with a new random suffix; the
 * occupying entry is left untouched. On failure the temp file this call
 * created is removed, best effort.
 */
export function createAgentKeyFile(privateKeyPath: string, data: string | Uint8Array): void {
  const bytes = Buffer.from(data);
  const tempPrefix = `.${basename(privateKeyPath)}.tmp-`;
  const maxTempAttempts = 5;
  let fd: number | undefined;
  let tempPath = "";
  let tempCreated = false;
  let attempt = 0;
  while (fd === undefined) {
    attempt += 1;
    const candidate = join(dirname(privateKeyPath), `${tempPrefix}${randomBytes(8).toString("hex")}`);
    try {
      fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      tempPath = candidate;
      tempCreated = true;
    } catch (error) {
      if (errnoCode(error) === "EEXIST" && attempt < maxTempAttempts) continue;
      throw error;
    }
  }
  try {
    // The open mode is narrowed by the umask; set it exactly, still before the
    // first byte, so the protection is the mode the file is created with.
    fchmodSync(fd, 0o600);
    testHooks?.beforeFirstWrite?.(fd);
    const writer = testHooks?.writeSeedFile ?? ((target: number, value: Buffer) => writeSync(target, value));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writer(fd, bytes.subarray(offset));
      if (written <= 0) {
        throw new Error(
          `short write to key file ${privateKeyPath}: wrote ${written} bytes with ${bytes.length - offset} left`,
        );
      }
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    testHooks?.beforePublish?.(tempPath, privateKeyPath);
    // linkSync fails with EEXIST when the final path appears before publication;
    // the caller then re-reads that file.
    linkSync(tempPath, privateKeyPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already failing */
      }
    }
    if (tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* best effort: remove only the temp file this call created */
      }
    }
    throw error;
  }
  try {
    unlinkSync(tempPath);
  } catch {
    /* the published key is complete; a leftover temp file is mode 0600 */
  }
}

/**
 * Reuse the key at `privateKeyPath` when it exists, otherwise write the bytes
 * `create` returns. An occupied path wins over `create` (an export that
 * carries another key does not replace one already on disk).
 */
export function readOrCreateAgentKey(
  privateKeyPath: string,
  create: () => string | Uint8Array,
): AgentKeyFileContents {
  const existing = readExistingAgentKey(privateKeyPath);
  if (existing) return { bytes: existing, created: false };

  const data = create();
  try {
    createAgentKeyFile(privateKeyPath, data);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      const raced = readExistingAgentKey(privateKeyPath);
      if (raced) return { bytes: raced, created: false };
    }
    throw error;
  }
  return { bytes: new Uint8Array(Buffer.from(data)), created: true };
}
