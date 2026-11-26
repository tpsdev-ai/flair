/**
 * agent-rotation-lock.ts — one exclusive per-agent lock for
 * `flair agent rotate-key` (flair#3151).
 *
 * Two rotations of the same agent used to interleave: each read the current
 * key, staged its own, sent the ops `update`, then renamed its staged key over
 * the current one. The stored public key could end up matching neither private
 * key on disk. This lock is taken BEFORE the current key is read and held
 * through the read-back check, the rename and the public-key write.
 *
 * Conventions follow src/lib/config-critical-section.ts:
 *   - the lock is an `O_EXCL` create of a file in the keys dir named for the
 *     agent; its content is `<pid> <iso> <hostname>` for diagnosis only and is
 *     never an authorization input (a blank or partial record refuses).
 *   - acquisition retries a bounded number of times, then refuses with a NAMED
 *     message that names the lock file and says to remove it only once no
 *     rotation of that agent is running.
 *   - there is no reclaim, no age-out and no pid-liveness shortcut: a lock left
 *     by a killed run keeps refusing until an operator removes it.
 *   - release removes only the lock file this run created: the device and inode
 *     recorded at create must match at release. A leaked lock refuses the next
 *     rotation; it never corrupts a key file.
 *
 * Release runs from an explicit `release()` and from a `process.once("exit")`
 * listener registered with the lock. `flair agent rotate-key` exits with
 * `process.exit(1)` on many failure paths, and `finally` does not run on
 * `process.exit`.
 *
 * On filesystems where `O_EXCL` is unreliable (NFS/SMB) the lock may not
 * serialize at all; that is the same residual config-critical-section.ts names.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Lock acquisition: bounded retry (default 40 × 50 ms). */
export const AGENT_ROTATION_LOCK_RETRY = { attempts: 40, delayMs: 50 } as const;

export interface AgentRotationLock {
  /** The lock file this run created. */
  path: string;
  /** Identity-checked removal; idempotent. Also runs from the exit listener. */
  release(): void;
}

export interface AgentRotationLockOptions {
  id: string;
  keysDir: string;
  /** Explicit lock path (default `<keysDir>/<id>.rotate-key.lock`). */
  lockPath?: string;
  retry?: { attempts: number; delayMs: number };
}

export type AgentRotationLockResult =
  | { ok: true; lock: AgentRotationLock }
  | { ok: false; message: string };

/** The lock path for one agent in one keys directory. */
export function agentRotationLockPath(keysDir: string, id: string): string {
  return join(keysDir, `${id}.rotate-key.lock`);
}

/** Synchronous backoff without a sleep primitive that differs between bun and node. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseLockHolder(raw: string | null): { pid: string; timestamp: string; host: string } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s+(\S+)\s+(\S+)$/);
  if (!m) return null;
  return { pid: m[1]!, timestamp: m[2]!, host: m[3]! };
}

function refusalLine(lockPath: string, id: string, holder: string | null): string {
  const parsed = parseLockHolder(holder);
  const who = parsed
    ? `recorded holder pid ${parsed.pid} since ${parsed.timestamp} on host ${parsed.host}`
    : "its contents are not a readable holder record (blank or partially written)";
  return (
    `another rotation of agent '${id}' holds ${lockPath} (${who}); refusing to rotate agent '${id}' without the lock. ` +
    `Remove ${lockPath} only once no rotation of that agent is running.`
  );
}

function makeHandle(lockPath: string, identity: { dev: number; ino: number }): AgentRotationLock {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    try {
      const st = lstatSync(lockPath);
      if (Number(st.dev) !== identity.dev || Number(st.ino) !== identity.ino) return;
      unlinkSync(lockPath);
    } catch {
      // ENOENT: the lock is already gone. Any other failure leaves a lock that
      // refuses the next rotation; it never touches a key file.
    }
  };
  process.once("exit", release);
  return { path: lockPath, release };
}

/**
 * Take the per-agent rotation lock, or refuse by name. A lock another run holds
 * is retried within the bound and then refused; the caller must exit without
 * reading or writing any key file.
 */
export function acquireAgentRotationLock(opts: AgentRotationLockOptions): AgentRotationLockResult {
  const lockPath = opts.lockPath ?? agentRotationLockPath(opts.keysDir, opts.id);
  const retry = { ...AGENT_ROTATION_LOCK_RETRY, ...opts.retry };
  for (let i = 0; i < retry.attempts; i++) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return {
          ok: false,
          message: `could not create the rotation lock ${lockPath} (${message(err)}); no key file was changed`,
        };
      }
      if (i < retry.attempts - 1) sleepSync(retry.delayMs);
      continue;
    }
    try {
      const st = fstatSync(fd);
      const identity = { dev: Number(st.dev), ino: Number(st.ino) };
      try {
        // Diagnostic only: never an authorization input.
        writeSync(fd, `${process.pid} ${new Date().toISOString()} ${hostname()}\n`);
      } catch {
        // The lock exists (that is what protects us); a failed diagnostic
        // write is not fatal.
      }
      return { ok: true, lock: makeHandle(lockPath, identity) };
    } finally {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
  let holder: string | null = null;
  try {
    holder = readFileSync(lockPath, "utf-8");
  } catch {
    holder = null;
  }
  return { ok: false, message: refusalLine(lockPath, opts.id, holder) };
}

/**
 * ENV-GATED test barrier for the real-server interleave test: after marking its
 * own `.ready` file, a rotation waits (bounded) for the `.go` file the test
 * drops. Inert unless `FLAIR_TEST_ROTATE_KEY_PAUSE` names a base path.
 *
 * TRUSTED-ENV ASSUMPTION: this path is only as privileged as the environment
 * that starts the CLI; a caller who can set it can already set `FLAIR_*` and
 * run the command itself. The wait always ends (40 × 25 ms × 30 = 30 s).
 */
export async function agentRotationTestPause(): Promise<void> {
  const base = process.env.FLAIR_TEST_ROTATE_KEY_PAUSE;
  if (!base) return;
  writeFileSync(`${base}.ready`, `${process.pid}\n`);
  for (let i = 0; i < 1200; i++) {
    if (existsSync(`${base}.go`)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`rotation test pause at ${base} timed out waiting for ${base}.go`);
}
