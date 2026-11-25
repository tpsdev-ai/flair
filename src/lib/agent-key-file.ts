/**
 * agent-key-file.ts — the one place an agent private-key file is created or
 * reused (flair#3077 slice A).
 *
 * The five paths that provision an agent key (`flair agent add`, local
 * `flair init --agent/--agent-id`, remote `flair init --target ... --agent-id`,
 * `flair principal add`, `flair import`) used to mkdir the keys directory with
 * default permissions, create the key at the umask default and chmod it
 * afterwards, and reuse an existing key whatever its mode. This module makes
 * the private key owner-only from the first byte and refuses a wider existing
 * key instead of changing it.
 *
 * POSIX policy:
 *   - the keys directory is created 0700; an existing directory owned by the
 *     current user is tightened to 0700 with one notice line; a symlink, a
 *     non-directory, or a directory owned by another user is refused.
 *   - a new key is opened O_CREAT|O_EXCL at 0600 before any byte is written;
 *     a failed write removes only the file this call created.
 *   - an existing key is checked on the OPENED DESCRIPTOR: a regular file,
 *     owned by the current user, with no group/world bits. It is read and left
 *     untouched; a wider file is refused before its bytes are read.
 *
 * win32: mode bits do not establish owner-only there, so today's create and
 * reuse behaviour is kept and nothing is refused for permissions.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";

/** A refusal is operator-facing: the caller prints the message and exits 1. */
export class AgentKeyFileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyFileRefusal";
  }
}

/** Test-only observation points; production leaves these unset. */
export interface AgentKeyFileTestHooks {
  /** Runs with the created key's descriptor before the first byte is written. */
  beforeFirstWrite?: (fd: number) => void;
  /** Replaces the seed write, so a test can fail it. */
  writeSeedFile?: (fd: number, bytes: Buffer) => void;
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
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is narrowed by the umask; the directory was created by this
    // call, so nothing else has observed it at a wider mode.
    chmodSync(keysDir, 0o700);
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
 * Read an existing key after checking the opened descriptor, or return null
 * when the path does not exist. A symlink or any other unsafe file refuses.
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
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/**
 * Create a new key file at 0600 from the first byte, refusing to overwrite an
 * existing path. A failed write removes only the file this call created.
 */
export function createAgentKeyFile(privateKeyPath: string, data: string | Uint8Array): void {
  if (WIN32) {
    writeFileSync(privateKeyPath, data, { mode: 0o600 });
    chmodSync(privateKeyPath, 0o600);
    return;
  }

  const fd = openSync(privateKeyPath, "wx", 0o600);
  try {
    // The open mode is narrowed by the umask; set it exactly, still before the
    // first byte, so the protection is the mode the file is created with.
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(data);
    testHooks?.beforeFirstWrite?.(fd);
    (testHooks?.writeSeedFile ?? ((target: number, value: Buffer) => writeSync(target, value)))(fd, bytes);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* already failing */
    }
    try {
      unlinkSync(privateKeyPath);
    } catch {
      /* best effort: remove only the file this call created */
    }
    throw error;
  }
  closeSync(fd);
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
