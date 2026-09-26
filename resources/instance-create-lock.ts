// instance-create-lock.ts — the critical section around the first-boot create in
// `GET /FederationInstance` (flair#1897 slice 1).
//
// WHY A FILESYSTEM LOCK, NOT AN IN-PROCESS ONE. A Harper store runs SEVERAL HTTP
// worker threads, each loading `dist/resources/*.js` in its own realm (Harper
// `server/threads/manageThreads.js` -> `new Worker(...)`; `threadServer.js` ->
// `loadRootComponents(true)`). `globalThis` is per worker, so an in-process chain
// does not serialise two GETs on two workers — both read `none`, both mint. On
// Linux Harper runs at least two workers by default (configValidator: threads
// count = cpus-1, floor 2), and Flair never writes that key. So the lock is a
// Flair-owned FILESYSTEM TICKET LOCK, cross-worker AND cross-process, under the
// same Flair home the keystore already relies on.
//
// WHAT IT COVERS. `findOrCreateInstance` holds the ticket across: the read that
// found no row, the mint, the `put`, the keystore seed write, and a confirming
// re-read. A GET that already found a row never takes the lock, so reads stay
// concurrent.
//
// TICKET PROTOCOL (Harper's own componentPreparationLock.ts is the reference for
// the pitfalls — not imported, it is not a package export):
//   - Each contender creates ONE claim file with the `wx` flag (O_EXCL):
//     `${zero-padded stamp}-${pid}-${threadId}-${token}.json`, content {pid,
//     threadId, token, createdAt}.
//   - The HOLDER is the lexicographically smallest claim whose owner pid is
//     alive (`process.kill(pid, 0)`; ESRCH = dead, EPERM = alive). Ordering only
//     has to be TOTAL and agreed among LIVE claims, so clock skew between workers
//     cannot break correctness — a claim that sorts early but is dead is deleted,
//     not honoured. The stamp is monotonic WITHIN a realm, and a claim must stay
//     the smallest LIVE one for LOCK_STABLE_MS before it holds, so two claims
//     stamped in the same millisecond (one per worker) can never BOTH hold.
//   - A claim whose pid is dead may be deleted by anyone — that specific file
//     only. Never the directory, never a live claim, never a reclaim-by-age.
//   - A wait DEADLINE (10 s) → delete YOUR OWN claim and REFUSE. Never steal a
//     live lock: a slow/paused holder outliving a lease is exactly how two
//     writers happen.
//   - Release = unlink your own claim in `finally`.
//   - The lock dir being unwritable (EACCES/ENOENT-on-create) → REFUSE identity
//     creation; never fall back to an in-process chain, never mint unlocked.
//
// SCOPE: this serialises the GET create path across the workers and processes
// that share one Flair home. `flair init --remote` (src/cli.ts) does not take the
// lock yet — the CLI writer must join it in slice 2.

import { readFileSync, readdirSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { threadId } from "node:worker_threads";
import { resolveHome } from "../src/lib/home.js";
import { decideInstanceAnswer, type InstanceIdentityRow } from "../src/lib/instance-identity-row.js";

export const LOCK_DEADLINE_MS = 10_000;
export const LOCK_WAIT_POLL_MS = 25;
/**
 * A contender must remain the smallest LIVE claim for this long before it holds.
 * Names sort by a millisecond stamp, and two realms (Harper HTTP workers) or two
 * processes can stamp the SAME millisecond; without this grace the later claim's
 * random token could sort it FIRST, so an earlier contender that already held
 * would not stand down — both mint. Requiring the smallest claim to be stable for
 * a full poll interval lets a lagging sibling become visible before any put.
 */
export const LOCK_STABLE_MS = 60;

/** The keystore-write failure note (flair#1233) — a read path must not abort. */
export const KEYSTORE_FAILURE_NOTE =
  "[federation] Could not store the federation signing key seed in the keystore " +
  "($HOME/.flair/keys, relative to the Harper process's HOME). The identity row was created and " +
  "reads work, but this instance cannot sign — pair/sync will fail until the keystore is fixed. " +
  "Remedy: make $HOME/.flair/keys a directory writable by the Harper process (mode 0700). " +
  "The seed for THIS identity was never stored, so after fixing the keystore, re-key: delete the " +
  "Instance row and re-pair to mint a fresh identity.";

/** The lock-dir remedy, in the same style as KEYSTORE_FAILURE_NOTE. */
export const LOCK_DIR_REMEDY =
  "Remedy: make the Flair home writable by the Harper process (a directory the process can create " +
  "$HOME/.flair/locks with mode 0700). Identity creation is REFUSED while the lock dir is unusable.";

/** The identity-create lock directory under a Flair home. */
export function instanceCreateLockDir(home?: string): string {
  return join(home ?? resolveHome(), ".flair", "locks", "instance-create");
}

/** `process.kill(pid, 0)`: ESRCH = dead, EPERM = alive (a live pid we can't signal). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

interface Claim {
  name: string;
  pid: number;
}

// Monotonic WITHIN a realm: two claims stamped in the same millisecond (the
// common case for concurrent requests in one worker) must still sort by creation
// order, so the later contender never sorts first. Sibling realms/processes are
// covered by LOCK_STABLE_MS.
let lastStamp = 0;
function nextStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

/** Live claims in the dir; DEAD claims are unlinked (that file only). */
export function listLiveClaims(dir: string): Claim[] {
  const out: Claim[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let pid = NaN;
    try {
      pid = Number(JSON.parse(readFileSync(join(dir, name), "utf8"))?.pid);
    } catch {
      continue;
    }
    if (pidAlive(pid)) out.push({ name, pid });
    else {
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* another contender removed it */
      }
    }
  }
  return out;
}

export type LockAcquire = { ok: true; release: () => void } | { ok: false; detail: string };

/**
 * Create a claim and wait until it is the holder. Returns a release fn, or a
 * refusal detail (deadline, or an unusable lock dir). Cross-worker/cross-process.
 */
export async function acquireInstanceCreateLock(
  opts: { home?: string; deadlineMs?: number; log?: (message: string) => void } = {},
): Promise<LockAcquire> {
  const dir = instanceCreateLockDir(opts.home);
  const log = opts.log ?? ((m) => console.error(m));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    return { ok: false, detail: `the identity-create lock dir is unusable (${dir}): ${err?.message ?? err}. ${LOCK_DIR_REMEDY}` };
  }

  const name = `${String(nextStamp()).padStart(15, "0")}-${process.pid}-${threadId}-${randomBytes(8).toString("hex")}.json`;
  const file = join(dir, name);
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, threadId, token: name.slice(-16), createdAt: new Date().toISOString() }), { flag: "wx" });
  } catch (err: any) {
    return { ok: false, detail: `could not create the identity-create claim (${file}): ${err?.message ?? err}. ${LOCK_DIR_REMEDY}` };
  }

  const release = (): void => {
    try {
      unlinkSync(file);
    } catch (err: any) {
      log(
        `[federation] identity-create lock: could not unlink ${file} on release (${err?.message ?? err}). ` +
          `That claim's pid stays alive, so later identity creation refuses until this process exits.`,
      );
    }
  };

  const deadline = Date.now() + (opts.deadlineMs ?? LOCK_DEADLINE_MS);
  let smallestSince: number | null = null;
  for (;;) {
    const live = listLiveClaims(dir).sort((a, b) => a.name.localeCompare(b.name));
    const holder = live[0];
    if (holder && holder.name === name) {
      // The smallest LIVE claim — but hold only once it has stayed smallest for
      // LOCK_STABLE_MS, so a sibling stamped in the same millisecond (that may
      // sort first once its file lands) is seen before either contender puts.
      smallestSince ??= Date.now();
      if (Date.now() - smallestSince >= LOCK_STABLE_MS) return { ok: true, release };
    } else {
      smallestSince = null;
    }
    if (Date.now() >= deadline) {
      release();
      const held = holder ? `holder claim ${holder.name}, pid ${holder.pid}` : "no live holder claim";
      return {
        ok: false,
        detail:
          `could not acquire the identity-create lock within ${(opts.deadlineMs ?? LOCK_DEADLINE_MS) / 1000}s ` +
          `(${held}). Remedy: retry; if it persists, restart the Harper process — a stuck holder inside the ` +
          `same process cannot be told from a live one.`,
      };
    }
    await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
  }
}

export interface CreateDeps {
  /** Every Instance row (the strict reader). */
  readAll: () => Promise<InstanceIdentityRow[]>;
  /** Write one row by its primary key. */
  put: (row: InstanceIdentityRow) => Promise<void> | void;
  /** Store the signing seed for `id` in the keystore. May throw. */
  setSeed: (id: string, seed: Uint8Array) => Promise<void> | void;
  /** Read-only keystore probe — never throws. */
  seedPresent: (id: string) => Promise<boolean> | boolean;
  /** Mint a fresh identity (id, publicKey, secretKey). */
  mint: () => { id: string; publicKey: string; secretKey: Uint8Array };
  /** Flair home the lock dir lives under (default: resolveHome()). */
  home?: string;
  lockDeadlineMs?: number;
  now?: () => string;
  log?: (message: string) => void;
}

export type CreateOutcome =
  | { kind: "refuse-multiple"; rows: InstanceIdentityRow[]; putCommitted: boolean; mintedId?: string }
  /** Post-put re-read saw NO row — the detached-commit seam failed. 5xx, no retry. */
  | { kind: "refuse-unobservable"; mintedId: string }
  /** Could not acquire the ticket lock (deadline, or unusable lock dir). 5xx. */
  | { kind: "refuse-lock"; detail: string }
  | { kind: "row"; row: InstanceIdentityRow; seeded: boolean; warning?: string };

/**
 * Find the instance identity, minting one only when a read UNDER the ticket lock
 * found no row. The lock is a filesystem ticket shared by every HTTP worker of
 * this Harper process AND every process sharing this Flair home (flair#1897), so
 * concurrent first-boot GETs mint ONE row and every caller is answered it.
 */
export async function findOrCreateInstance(deps: CreateDeps): Promise<CreateOutcome> {
  const log = deps.log ?? ((m) => console.error(m));
  const now = deps.now ?? (() => new Date().toISOString());
  const lock = await acquireInstanceCreateLock({ home: deps.home, deadlineMs: deps.lockDeadlineMs, log });
  if (!lock.ok) return { kind: "refuse-lock", detail: lock.detail };
  try {
    const rows = await deps.readAll();
    const decision = decideInstanceAnswer(rows);
    if (decision.kind === "refuse-multiple") return { kind: "refuse-multiple", rows: decision.rows, putCommitted: false };
    if (decision.kind === "answer") return { kind: "row", row: decision.row, seeded: await deps.seedPresent(decision.row.id) };

    // No row on a read taken UNDER the lock — the one state that may create.
    const { id, publicKey, secretKey } = deps.mint();
    const row = {
      id,
      publicKey,
      role: "spoke",
      status: "active",
      createdAt: now(),
      updatedAt: now(),
    } as InstanceIdentityRow & { updatedAt: string };
    await deps.put(row);

    let seeded = false;
    try {
      await deps.setSeed(id, secretKey.slice(0, 32));
      seeded = true;
    } catch (err: any) {
      log(`${KEYSTORE_FAILURE_NOTE} ${err?.constructor?.name ?? "Error"}: ${err?.message ?? err}`);
    }

    // Confirming re-read — what is actually there now is what we return.
    const after = await deps.readAll();
    const confirmed = decideInstanceAnswer(after);
    if (confirmed.kind === "refuse-multiple") {
      // This request's own detached put committed a row AND the table holds >1.
      return { kind: "refuse-multiple", rows: confirmed.rows, putCommitted: true, mintedId: id };
    }
    if (confirmed.kind === "none") {
      // The detached put COMMITS BEFORE IT RESOLVES, so a `none` re-read means
      // the seam failed. NO retry — a retry can only mask it. Refuse (5xx).
      return { kind: "refuse-unobservable", mintedId: id };
    }
    if (confirmed.row.id !== id) {
      // A row written outside this lock. Practically unreachable now that the put
      // commits under the lock — a cheap safety net, not an outside-writer claim.
      return {
        kind: "row",
        row: confirmed.row,
        seeded: await deps.seedPresent(confirmed.row.id),
        warning: `GET /FederationInstance: this caller minted ${id} but the confirmed row is ${confirmed.row.id} — answering the survivor, deleting nothing.`,
      };
    }
    // Return the RE-READ row (never the local object we minted).
    return { kind: "row", row: confirmed.row, seeded };
  } finally {
    lock.release();
  }
}
