/**
 * remote-admin-pass.ts — save the Flair administrator password chosen for a
 * remote `flair init` provisioning run BEFORE the cluster change that applies
 * it (flair#3130).
 *
 * Save before the cluster change so a failed save stops provisioning.
 * An existing credential stays in place until the staged value is confirmed.
 * After a password request is attempted, retain the stage for recovery.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Writes `content` at `path` owner-only (mode 0600). */
export type OwnerOnlyWriter = (path: string, content: string) => void;

/** A save/confirm refusal. The caller prints the message (which names the file). */
export class RemoteAdminPassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteAdminPassError";
  }
}

export interface RemoteAdminPassStage {
  /** The final credential path. */
  readonly path: string;
  /** True when a file was already present and must stay unchanged on failure. */
  readonly hadExistingFile: boolean;
  /** The staged sibling holding the new value, or null when the value went to `path` directly. */
  readonly stagedPath: string | null;
  /** True after the staged file passes verification. */
  readonly stagedFileVerified: boolean;
  /** Verify the saved value and publish a staged file. */
  confirm(): void;
  /** Attempts to remove the staged copy; a newly saved file is kept. */
  abort(): void;
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : undefined;
}

const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const O_NONBLOCK = process.platform === "win32" ? 0 : constants.O_NONBLOCK;

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function assertReplaceableTarget(path: string, st: Stats): void {
  if (st.isSymbolicLink()) {
    throw new RemoteAdminPassError(
      `credential file ${path} is a symbolic link; replace it with a real regular file you own`,
    );
  }
  if (!st.isFile()) {
    throw new RemoteAdminPassError(
      `credential file ${path} is not a regular file; make it a writable regular file you own`,
    );
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new RemoteAdminPassError(
      `credential file ${path} is owned by another user; move it aside so flair can write a file you own`,
    );
  }
}

/** Read the final path's current state, or null when it does not exist. */
function readTarget(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** The file must hold exactly the saved bytes and be owner-only. */
function verifySaved(path: string, expected: string): void {
  // Open once; no-follow on POSIX, ordinary open on Windows. Stat and read
  // through that descriptor.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new RemoteAdminPassError(
        `credential file ${path} is a symbolic link after saving; replace it with a real regular file you own`,
      );
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new RemoteAdminPassError(`credential file ${path} is not a regular file after saving`);
    }
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      throw new RemoteAdminPassError(`credential file ${path} is owned by another user after saving`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new RemoteAdminPassError(
        `credential file ${path} is accessible to other users after saving (mode ${modeText(st.mode)}); run chmod 600 ${path}`,
      );
    }
    const actual = readFileSync(fd, "utf8");
    if (actual !== expected) {
      throw new RemoteAdminPassError(`credential file ${path} does not hold the saved value after saving`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Save `password` to `path` before the cluster change. Returns a stage whose
 * `confirm()` must run after the change succeeds.
 *
 * - No existing file: writes `path` now (0600); `abort()` is a no-op because
 *   the saved value is kept for a later run.
 * - Existing file: writes a mode-0600 sibling and `confirm()` renames it over
 *   `path`; `abort()` attempts to remove the sibling and leaves `path` untouched.
 */
export function stageRemoteAdminPassword(
  path: string,
  password: string,
  writeOwnerOnly: OwnerOnlyWriter,
): RemoteAdminPassStage {
  const content = password + "\n";
  const current = readTarget(path);

  if (current === null) {
    writeOwnerOnly(path, content);
    return {
      path,
      hadExistingFile: false,
      stagedPath: null,
      stagedFileVerified: false,
      confirm: () => verifySaved(path, content),
      abort: () => {
        /* the freshly saved value is kept for the next run */
      },
    };
  }

  assertReplaceableTarget(path, current);
  const pending = join(
    dirname(path),
    `.${basename(path)}.pending-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  writeOwnerOnly(pending, content);

  let stagedFileVerified = false;
  return {
    path,
    hadExistingFile: true,
    stagedPath: pending,
    get stagedFileVerified() { return stagedFileVerified; },
    confirm: () => {
      // Check before publishing; retain the stage on failure for recovery.
      // Rename publishes the checked file unless the staged path is replaced in between.
      stagedFileVerified = false;
      verifySaved(pending, content);
      stagedFileVerified = true;
      renameSync(pending, path);
    },
    abort: () => {
      try {
        unlinkSync(pending);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      }
    },
  };
}
