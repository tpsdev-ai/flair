/**
 * Test pause for owned transactions (flair#2307), enabled by process environment.
 * Claims an arm file, writes pause/release markers, and waits for go or its limit.
 * Pinned by test/unit/txn-pause-point.test.ts and used by
 * test/integration/supersede-close-contention-2307.test.ts,
 * test/integration/embedding-stamp-contention-2307.test.ts,
 * test/integration/owner-delete-recheck-2355.test.ts and
 * test/integration/integration-row-write-serialization-2340.test.ts.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export const TEST_FAULT_INJECTION_ENV = "FLAIR_ENABLE_TEST_FAULT_INJECTION";
export const TEST_PAUSE_DIR_ENV = "FLAIR_TEST_PAUSE_DIR";
export const PAUSE_LIMIT_MS = 20_000;
const POLL_MS = 20;

/** One point per owned transaction that writes from a row it read.
 *
 * flair#2355 — a non-admin owner-scoped delete. Each delete has a `-pre` point
 * (after the pre-existing ownership read, before the delete's transactional
 * re-read or staging) and an in-transaction point (between that transaction's
 * ownership re-read and its delete), so both interleavings of a concurrent
 * owner change can be exercised. The write transaction is one the delete
 * owns, except Memory's ordinary delete: withSharedWriteTransaction JOINS a
 * request-owned transaction when one exists and creates one otherwise.
 */
export type TxnPausePoint =
  | "supersede-close"
  | "embedding-stamp-content-suffix"
  | "integration-row-write"
  | "memory-delete-pre"
  | "memory-delete"
  | "memory-skill-delete-pre"
  | "memory-skill-delete"
  | "credential-delete-pre"
  | "credential-delete"
  | "grant-delete-pre"
  | "grant-delete"
  | "workspace-delete-pre"
  | "workspace-delete"
  | "candidate-delete-pre"
  | "candidate-delete"
  | "relationship-delete-pre"
  | "relationship-delete"
  | "feed-dedup-repair";

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

let refusalLogged = false;
function logRefusal(): void {
  if (refusalLogged) return;
  refusalLogged = true;
  console.warn("txn-pause-point: filesystem check failed; hook inert");
}

export function txnPausePoint(
  point: TxnPausePoint,
  env: NodeJS.ProcessEnv = process.env,
  limitMs: number = PAUSE_LIMIT_MS,
): Promise<void> | undefined {
  if (env[TEST_FAULT_INJECTION_ENV] !== "1") return undefined;
  let armFd: number | undefined;
  let pausedFd: number | undefined;
  let releasedFd: number | undefined;
  let dir: string;
  try {
    const configured = env[TEST_PAUSE_DIR_ENV];
    if (!configured || !isAbsolute(configured) || !process.getuid || !constants.O_NOFOLLOW) throw new Error();
    dir = realpathSync(configured);
    const info = statSync(dir);
    if (lstatSync(configured).isSymbolicLink() || !isInside(realpathSync(tmpdir()), dir) ||
      !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw new Error();
    const armPath = join(dir, `arm.${point}`);
    try {
      armFd = openSync(armPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!fstatSync(armFd).isFile()) throw new Error();
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const claimedFd = openSync(join(dir, `claimed.${point}`), flags, 0o600);
    closeSync(claimedFd);
    pausedFd = openSync(join(dir, `paused.${point}`), flags, 0o600);
    releasedFd = openSync(join(dir, `released.${point}`), flags, 0o600);
    writeFileSync(pausedFd, String(Date.now()));
    unlinkSync(armPath);
  } catch {
    if (pausedFd !== undefined) closeSync(pausedFd);
    if (releasedFd !== undefined) closeSync(releasedFd);
    logRefusal();
    return undefined;
  } finally {
    if (armFd !== undefined) closeSync(armFd);
  }
  const paused = pausedFd;
  const released = releasedFd;
  return (async () => {
    try {
      const go = join(dir, `go.${point}`);
      const deadline = Date.now() + limitMs;
      while (!existsSync(go) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      writeFileSync(released, existsSync(go) ? "go" : "timeout");
    } catch {
      logRefusal();
    } finally {
      closeSync(paused);
      closeSync(released);
    }
  })();
}
