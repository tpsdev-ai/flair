// instance-create-lock.ts — the in-process critical section around the
// first-boot create in `GET /FederationInstance` (flair#1897 slice 1).
//
// WHY A PROCESS-LOCAL LOCK IS ENOUGH. A store runs ONE Harper process: every
// concurrent `GET /FederationInstance` that races the first boot is a request on
// the same process, and Sherlock's point stands — the keystore is shared, so a
// loser's answered identity is signable either way. Serialising the
// read→create→re-read in-process is therefore the correct and cheapest fix; a
// cross-process on-disk lock is not needed.
//
// WHAT IT COVERS. The lock wraps exactly one attempt to ANSWER the identity:
// the read that found no row, the mint, the `put`, the keystore seed write, and
// a confirming re-read. A GET that already found a row never takes the lock, so
// reads stay concurrent. Nothing is ever deleted: if the confirming re-read
// shows a row this caller did NOT mint (only possible if something outside the
// lock wrote), the caller is answered the survivor and warned with both ids.
//
// SCOPE: this serialises GETs in THIS process. An independent writer — `flair
// init --remote` writes the Instance row outside this lock (src/cli.ts ~3421) —
// can still race a first-boot GET; that writer is slice 2, not covered here.

import { decideInstanceAnswer, type InstanceIdentityRow } from "../src/lib/instance-identity-row.js";

/** The serialising chain. Held on globalThis so it survives any module instance
 *  boundary Harper may create between requests. */
function chainSlot(): { chain: Promise<unknown> } {
  const g = globalThis as any;
  return (g.__flairInstanceCreateChain ??= { chain: Promise.resolve() });
}

/**
 * Run `fn` in the create critical section. The chain is advanced by a settled
 * promise, so a rejection inside `fn` never poisons it (the next caller still
 * runs). Only the create path calls this.
 */
export function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  const slot = chainSlot();
  const run = slot.chain.then(fn, fn);
  slot.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The keystore-write failure note (flair#1233) — a read path must not abort. */
export const KEYSTORE_FAILURE_NOTE =
  "[federation] Could not store the federation signing key seed in the keystore " +
  "($HOME/.flair/keys, relative to the Harper process's HOME). The identity row was created and " +
  "reads work, but this instance cannot sign — pair/sync will fail until the keystore is fixed. " +
  "Remedy: make $HOME/.flair/keys a directory writable by the Harper process (mode 0700). " +
  "The seed for THIS identity was never stored, so after fixing the keystore, re-key: delete the " +
  "Instance row and re-pair to mint a fresh identity.";

export interface CreateDeps {
  /** Every Instance row (the strict reader — throws on an unreadable table). */
  readAll: () => Promise<InstanceIdentityRow[]>;
  /** Write one row by its primary key. */
  put: (row: InstanceIdentityRow) => Promise<void> | void;
  /** Store the signing seed for `id` in the keystore. May throw. */
  setSeed: (id: string, seed: Uint8Array) => Promise<void> | void;
  /** Read-only keystore probe — never throws. */
  seedPresent: (id: string) => Promise<boolean> | boolean;
  /** Mint a fresh identity (id, publicKey, secretKey). */
  mint: () => { id: string; publicKey: string; secretKey: Uint8Array };
  now?: () => string;
  log?: (message: string) => void;
}

export type CreateOutcome =
  | { kind: "refuse-multiple"; rows: InstanceIdentityRow[] }
  | { kind: "row"; row: InstanceIdentityRow; seeded: boolean; warning?: string };

/**
 * Find the instance identity, minting one only when a read under the lock found
 * no row. Serialised by `withCreateLock`, so two concurrent first-boot GETs mint
 * ONE row and both are answered with it (flair#1897). `deps` is injectable so a
 * fake table can drive the S1/S4 interleavings in a unit test.
 */
export async function findOrCreateInstance(deps: CreateDeps): Promise<CreateOutcome> {
  const log = deps.log ?? ((m) => console.error(m));
  const now = deps.now ?? (() => new Date().toISOString());
  return withCreateLock(async () => {
    const rows = await deps.readAll();
    const decision = decideInstanceAnswer(rows);
    if (decision.kind === "refuse-multiple") return { kind: "refuse-multiple", rows: decision.rows };
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

    // Confirming re-read: answer the row that is actually there now.
    const after = await deps.readAll();
    const confirmed = decideInstanceAnswer(after);
    if (confirmed.kind === "refuse-multiple") return { kind: "refuse-multiple", rows: confirmed.rows };
    if (confirmed.kind === "answer" && confirmed.row.id !== id) {
      return {
        kind: "row",
        row: confirmed.row,
        seeded: await deps.seedPresent(confirmed.row.id),
        warning:
          `GET /FederationInstance: this caller minted ${id} but the confirmed row is ${confirmed.row.id} ` +
          `(written outside the create lock) — answering the survivor, deleting nothing.`,
      };
    }
    return { kind: "row", row, seeded };
  });
}
