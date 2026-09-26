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
// Flair-owned FILESYSTEM BAKERY LOCK, cross-worker AND cross-process, under the
// store root this process serves (`<rootPath>/flair-locks/instance-create/`) — NOT the keystore: flair#1233 requires an unusable `$HOME/.flair` to leave the read path working (the row is still created).
//
// WHAT IT COVERS. `findOrCreateInstance` holds the lock across: the read that
// found no row, the mint, the `put`, the keystore seed write, and a confirming
// re-read. A GET that already found a row never takes the lock, so reads stay
// concurrent.
//
// TICKET PROTOCOL — LAMPORT'S BAKERY ON FILES (Harper's own
// componentPreparationLock.ts is the reference for the pitfalls — not imported,
// it is not a package export). No timing assumption: only atomic `wx` create,
// atomic rename within one directory, and live-pid detection (`process.kill(pid,
// 0)`; ESRCH = dead, EPERM = alive).
//   - CHOOSE: write the claim JSON to `tmp-<token>.json` (never listed), then
//     `rename` it to `choosing-<pid>-<threadId>-<token>.json`. A visible claim is
//     therefore ALWAYS complete — `writeFileSync` exposing a half-written file is
//     closed off. Any visible claim that still fails to parse is treated as a LIVE
//     BLOCKER (wait), never skipped; if that persists to the deadline the refusal
//     names the file.
//   - TICKET: list the directory; ticket = 1 + max(ticket of every visible
//     `ticket-…` claim, dead or alive; 0 if none). Atomically rename `choosing-…`
//     -> `ticket-<zero-padded ticket>-<pid>-<threadId>-<token>.json`.
//   - WAIT: poll (LOCK_WAIT_POLL_MS); list; unlink `ticket-…` and `choosing-…`
//     claims whose pid is dead (that file only); if ANY live `choosing-…` claim
//     exists -> keep waiting; else the holder is the live `ticket-…` claim with
//     the smallest (ticket, name); if it is mine -> HOLD; else wait. Deadline ->
//     unlink my own claim(s) and REFUSE with the truth (the holder claim, or
//     "a contender is still choosing: <file>").
//   - CORRECTNESS. My ticket is chosen only AFTER my choosing marker is visible.
//     Any contender that has already decided either saw my marker (and waits), or
//     its ticket was visible when I chose — and then mine is strictly larger.
//     Concurrent choosers see each other's markers, both wait, and the tie on
//     equal tickets is broken by name. A crash between CHOOSE and TICKET leaves a
//     dead-pid choosing claim that others unlink.
//   - FAILURE MODE (fail closed). A dead WORKER THREAD inside a live process (or
//     a reused pid / EPERM) leaves a claim that blocks every contender until the
//     deadline -> refusals until the process restarts. `createdAt` stays
//     informational; process-start identity is a possible later refinement, not
//     this PR.
//   - Release = unlink your own claim in `finally`.
//   - The lock dir being unwritable (EACCES/ENOENT-on-create) -> REFUSE identity
//     creation; never fall back to an in-process chain, never mint unlocked.
//
// SCOPE: this serialises the GET create path across the workers and processes
// that share one Flair home. `flair init --remote` (src/cli.ts) does not take the
// lock yet — the CLI writer must join it in slice 2.

import { readFileSync, readdirSync, mkdirSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { threadId } from "node:worker_threads";
import { decideInstanceAnswer, type InstanceIdentityRow } from "../src/lib/instance-identity-row.js";

export const LOCK_DEADLINE_MS = 10_000;
export const LOCK_WAIT_POLL_MS = 25;

/** TEST-ONLY hooks, awaited at the choosing/ticket points. Never set in production. */
export interface LockHooks {
  afterChoosing?: () => Promise<void> | void;
  afterTicket?: () => Promise<void> | void;
}

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

/**
 * Harper's data root for THIS process — the `ROOTPATH` env var Harper sets for a
 * component (read the same way `resources/models-dir.ts` reads it). The lock lives
 * with the STORE it protects, never with the keystore.
 */
export function harperRootPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = (env.ROOTPATH ?? "").trim();
  return root || process.cwd();
}

/**
 * The identity-create lock directory. It lives with the STORE whose Instance table
 * it protects — `<rootPath>/flair-locks/instance-create/` — NOT under the keystore's
 * `$HOME/.flair`. WHY: flair#1233's contract is that an UNUSABLE keystore must not
 * abort the read path (the identity row is still created and reads answer 200 with
 * `signingKeyAvailable:false`); a lock under `$HOME/.flair` turned a FILE
 * `HOME/.flair` into a 503. A store whose ROOT is unwritable cannot run Harper at
 * all, so an unusable lock dir THERE is a genuine refusal and stays one.
 * `lockRoot` is a TEST seam only; production never passes it.
 */
export function instanceCreateLockDir(lockRoot?: string): string {
  return join(lockRoot ?? harperRootPath(), "flair-locks", "instance-create");
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

const CHOOSING_RE = /^choosing-(\d+)-(\d+)-[0-9a-f]+\.json$/;
const TICKET_RE = /^ticket-(\d+)-(\d+)-(\d+)-[0-9a-f]+\.json$/;

interface Claim {
  name: string;
  kind: "choosing" | "ticket";
  pid: number;
  ticket: number | null;
}

/**
 * Split the lock dir into: live claims, and BLOCKERS — recognised claim files
 * whose BODY is missing, invalid, or whose `pid` disagrees with the pid in the
 * FILENAME. A recognised claim's pid is taken FROM THE FILENAME; the body only
 * corroborates it. A mismatch is a live BLOCKER (wait; the deadline names it) and
 * is NEVER unlinked by another contender; only a claim whose FILENAME pid is
 * provably dead (ESRCH) is unlinked. Stray names (not tmp-/choosing-/ticket-)
 * stay ignored.
 */
export function listClaims(dir: string): { claims: Claim[]; blockers: string[] } {
  const claims: Claim[] = [];
  const blockers: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { claims, blockers };
  }
  for (const name of names) {
    const choosing = CHOOSING_RE.exec(name);
    const ticket = TICKET_RE.exec(name);
    if (!choosing && !ticket) continue; // tmp-… and foreign files are not claims
    // The pid is the FILENAME's: choosing-<pid>-<tid>-<token>; ticket-<n>-<pid>-<tid>-<token>.
    const filePid = Number(choosing ? choosing[1] : ticket![2]);
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      // A visible claim whose body cannot be read is a LIVE BLOCKER.
      blockers.push(name);
      continue;
    }
    const bodyPid = Number(parsed?.pid);
    if (!Number.isInteger(bodyPid) || bodyPid !== filePid) {
      // Missing / invalid / filename-mismatched body: a LIVE BLOCKER, never "dead".
      blockers.push(name);
      continue;
    }
    if (pidAlive(filePid)) {
      claims.push({ name, kind: choosing ? "choosing" : "ticket", pid: filePid, ticket: ticket ? Number(ticket[1]) : null });
    } else {
      // Only a provably-dead FILENAME pid is reclaimed (that file only).
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* another contender removed it */
      }
    }
  }
  return { claims, blockers };
}

/** ticket = 1 + max(ticket of every visible ticket-… claim, dead or alive; 0 if none). */
export function nextTicket(dir: string): number {
  let max = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 1;
  }
  for (const name of names) {
    const m = TICKET_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export type LockAcquire = { ok: true; release: () => void } | { ok: false; detail: string };

/**
 * Take the bakery lock: CHOOSE (write+rename a `choosing` marker), TICKET
 * (rename to a `ticket` claim), then WAIT until mine is the smallest live ticket.
 * Returns a release fn, or a refusal detail (deadline, or an unusable lock dir).
 * Cross-worker and cross-process.
 */
export async function acquireInstanceCreateLock(
  opts: { lockRoot?: string; deadlineMs?: number; log?: (message: string) => void; hooks?: LockHooks } = {},
): Promise<LockAcquire> {
  const dir = instanceCreateLockDir(opts.lockRoot);
  const log = opts.log ?? ((m) => console.error(m));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    return { ok: false, detail: `the identity-create lock dir is unusable (${dir}): ${err?.message ?? err}. ${LOCK_DIR_REMEDY}` };
  }

  const pid = process.pid;
  const tid = threadId;
  const token = randomBytes(8).toString("hex");
  const tmpFile = join(dir, `tmp-${token}.json`);
  const choosingFile = join(dir, `choosing-${pid}-${tid}-${token}.json`);
  const payload = JSON.stringify({ pid, threadId: tid, token, createdAt: new Date().toISOString() });

  // Every file this contender created. `release` unlinks them (ENOENT ignored) and
  // is called on EVERY exit — a hold, a refusal, or a throw from a hook — so no
  // claim is ever left behind by a contender that did not hold.
  const mine = new Set<string>();
  const release = (): void => {
    for (const f of [...mine]) {
      try {
        unlinkSync(f);
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          log(
            `[federation] identity-create lock: could not unlink ${f} on release (${err?.message ?? err}). ` +
              `That claim's pid stays alive, so later identity creation refuses until this process exits.`,
          );
        }
      }
      mine.delete(f);
    }
  };

  // The deadline starts BEFORE CHOOSE, so a contender held in the choosing state
  // past it removes its marker and refuses too.
  const deadline = Date.now() + (opts.deadlineMs ?? LOCK_DEADLINE_MS);
  let ticketName = "";
  try {
    // CHOOSE: a visible claim is written complete (tmp then atomic rename).
    try {
      writeFileSync(tmpFile, payload, { flag: "wx", mode: 0o600 });
      mine.add(tmpFile);
      renameSync(tmpFile, choosingFile);
      mine.delete(tmpFile);
      mine.add(choosingFile);
    } catch (err: any) {
      release();
      return { ok: false, detail: `could not create the identity-create claim (${choosingFile}): ${err?.message ?? err}. ${LOCK_DIR_REMEDY}` };
    }
    await opts.hooks?.afterChoosing?.();

    if (Date.now() >= deadline) {
      release();
      return {
        ok: false,
        detail:
          `could not acquire the identity-create lock within ${(opts.deadlineMs ?? LOCK_DEADLINE_MS) / 1000}s ` +
          `(a contender is still choosing: ${choosingFile}). Remedy: retry; if it persists, restart the Harper process.`,
      };
    }

    // TICKET: 1 + the max ticket any visible ticket claim carries.
    const ticket = nextTicket(dir);
    ticketName = `ticket-${String(ticket).padStart(12, "0")}-${pid}-${tid}-${token}.json`;
    const ticketFile = join(dir, ticketName);
    try {
      renameSync(choosingFile, ticketFile);
      mine.delete(choosingFile);
      mine.add(ticketFile);
    } catch (err: any) {
      release();
      return { ok: false, detail: `could not create the identity-create ticket (${ticketFile}): ${err?.message ?? err}. ${LOCK_DIR_REMEDY}` };
    }
    await opts.hooks?.afterTicket?.();

    for (;;) {
      const { claims, blockers } = listClaims(dir);
      const liveChoosing = claims.filter((c) => c.kind === "choosing");
      const liveTickets = claims
        .filter((c) => c.kind === "ticket")
        .sort((a, b) => (a.ticket! - b.ticket!) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      if (blockers.length === 0 && liveChoosing.length === 0 && liveTickets[0]?.name === ticketName) {
        return { ok: true, release };
      }
      if (Date.now() >= deadline) {
        release();
        const held =
          blockers.length > 0
            ? `the blocking claim ${blockers[0]}`
            : liveChoosing.length > 0
              ? `the blocking claim ${liveChoosing[0].name} (still choosing)`
              : liveTickets.length > 0
                ? `holder claim ${liveTickets[0].name}, pid ${liveTickets[0].pid}`
                : "no live holder claim";
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
  } catch (err) {
    // A throw anywhere (including from a hook) releases whatever we created.
    release();
    throw err;
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
  /** TEST-ONLY: the store root the lock dir lives under. Production uses ROOTPATH. */
  lockRoot?: string;
  lockDeadlineMs?: number;
  now?: () => string;
  log?: (message: string) => void;
  /** TEST-ONLY: awaited at the lock's choosing/ticket points. */
  hooks?: LockHooks;
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
 * found no row. The lock is a filesystem bakery shared by every HTTP worker of
 * this Harper process AND every process sharing this Flair home (flair#1897), so
 * concurrent first-boot GETs mint ONE row and every caller is answered it.
 */
export async function findOrCreateInstance(deps: CreateDeps): Promise<CreateOutcome> {
  const log = deps.log ?? ((m) => console.error(m));
  const now = deps.now ?? (() => new Date().toISOString());
  const lock = await acquireInstanceCreateLock({ lockRoot: deps.lockRoot, deadlineMs: deps.lockDeadlineMs, log, hooks: deps.hooks });
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
      // A row written outside this lock. Practically unreachable now that the
      // put commits under the lock — a cheap safety net, not an outside-writer
      // claim.
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
