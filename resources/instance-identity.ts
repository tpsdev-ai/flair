import { decideInstanceAnswer, INSTANCE_ROW_PRUNE_REMEDY } from "../src/lib/instance-identity-row.js";
import { readAllInstanceRows } from "./instance-identity-rows.js";

/**
 * ─── Local instance identity (federation-edge-hardening slice 1) ────────────
 *
 * The write-time `originatorInstanceId` stamp (Memory.ts/Soul.ts/Agent.ts/
 * Relationship.ts post()/put()) needs to know THIS instance's own federation
 * identity — the same `id` FederationInstance.get() (resources/Federation.ts)
 * finds-or-creates on first boot and persists in the `Instance` table
 * (schemas/federation.graphql). Exactly one row is expected in a given
 * instance's own Instance table — that row IS this instance; other instances
 * it has paired with live in the separate `Peer` table, never here.
 *
 * Deliberately READ-ONLY: this module never creates an Instance row — that
 * first-boot bootstrap (keypair generation + keystore write) stays
 * FederationInstance.get()'s job (resources/Federation.ts). If no Instance
 * row exists yet (a fresh, never-federated instance, or a unit-test
 * environment with no Instance table at all), localInstanceId() resolves to
 * null and callers stamp nothing — originatorInstanceId is nullable by
 * design (schemas/memory.graphql), and a null tag reads as "pre-tag /
 * local-origin by default" per the federation-edge-hardening design.
 *
 * Cached at module scope after the FIRST successful resolution — a write
 * must not pay a DB lookup every call. An unresolved (null) result is NOT
 * cached, since that state can legitimately change later (federation gets
 * bootstrapped after this process already started serving writes) and the
 * cost of re-checking only applies to instances that have never federated.
 *
 * ─── Several Instance rows: stamp NOTHING (flair#1896) ──────────────────────
 *
 * The `Instance` table can hold more than one row (a legacy install, or init's
 * detected race) — a state `flair doctor` reports and `flair init --remote`
 * refuses to create. This used to take the first row of an unordered
 * `Instance.search()` and cache that as THIS instance's id, so with several
 * rows every local record was stamped with an arbitrary identity — one peers
 * may never have pinned.
 *
 * With several rows this module now decides through the SAME shared rule the
 * other readers use (`decideInstanceAnswer`, src/lib/instance-identity-row.ts)
 * and stamps nothing: a null `originatorInstanceId` is the defined
 * local-origin state (schemas/memory.graphql). It does NOT throw — a throw
 * here would fail every local write on such an instance, and a legacy install
 * could lose writes on upgrade.
 *
 * The refusal is cached for at most LOCAL_INSTANCE_REFUSAL_TTL_MS so a write
 * in that state does not re-read the table on every call, and a prune takes
 * effect within the window without a restart. ONE error naming the row count
 * and the prune remedy is logged per refusal window — a bounded line, one per
 * window rather than one per write.
 *
 * The read goes through the SAME strict reader the GET uses
 * (`readAllInstanceRows`, resources/Federation.ts): an entry a reader cannot
 * name is an UNREADABLE read, not a smaller list, and it follows the
 * failed-read path here (null, uncached).
 */
let cachedInstanceId: string | null = null;

/** While `Date.now() < refusalUntilMs` a several-rows refusal is cached. 0 = none. */
let refusalUntilMs = 0;

/** Whether the several-rows refusal has already been logged in the current
 * refusal window. Re-armed when a window expires, so a table that stays
 * multi-row logs again once per window rather than once per process. */
let refusalLogged = false;

/** The row count of the current refusal window, for the log line. */
let refusalRowCount = 0;

/**
 * How long a several-rows refusal is remembered before the table is re-read.
 * "At most a minute" (flair#1896): a write in that state does not pay a table
 * read every call, and a prune takes effect within the window, no restart.
 */
const LOCAL_INSTANCE_REFUSAL_TTL_MS = 60_000;

/**
 * Emit the several-rows refusal line ONCE per refusal window. Called wherever
 * the refusal is observed — the fresh read that arms the window and every
 * cached answer inside it — so the once-per-window invariant holds on EVERY
 * path, not just the first. A no-op after the window's first line.
 */
function logRefusalOnce(): void {
  if (refusalLogged) return;
  refusalLogged = true;
  console.error(
    `[identity] this instance has ${refusalRowCount} Instance rows, so it has no single canonical identity to stamp on local writes — ` +
      "records are written with no originatorInstanceId (the local-origin state) until the table is resolved. " +
      `Keep one row and delete the rest with: ${INSTANCE_ROW_PRUNE_REMEDY}`,
  );
}

export async function localInstanceId(): Promise<string | null> {
  if (cachedInstanceId) return cachedInstanceId;

  const now = Date.now();
  if (refusalUntilMs > now) {
    // Cached refusal — no read this call. Still go through the guarded log:
    // within a window it is a no-op, but the invariant is enforced here too.
    logRefusalOnce();
    return null;
  }
  // Past the window (or never armed): re-arm the once-per-window log line, so a
  // table that is STILL multi-row after the window logs again exactly once.
  refusalLogged = false;

  let rows;
  try {
    rows = await readAllInstanceRows();
  } catch {
    // Instance table not present (test env / not yet migrated), a read that
    // FAILED, or a read that returned an entry without a usable id (which the
    // strict reader treats as unreadable) — no local id, uncached, exactly as
    // a table with no rows. Any of these can change on the next call.
    return null;
  }

  const decision = decideInstanceAnswer(rows);

  if (decision.kind === "answer") {
    cachedInstanceId = decision.row.id;
    refusalUntilMs = 0;
    return cachedInstanceId;
  }

  if (decision.kind === "refuse-multiple") {
    refusalRowCount = decision.rows.length;
    logRefusalOnce();
    refusalUntilMs = now + LOCAL_INSTANCE_REFUSAL_TTL_MS;
    return null;
  }

  // "none" — a SUCCESSFUL read found no Instance row: null, uncached, as today.
  return null;
}

/**
 * Test-only: force re-resolution on the next localInstanceId() call. The
 * module-level cache otherwise persists across test files that share the
 * same `bun test` process (same collision class documented in
 * memory-integrity.test.ts re: the Memory class singleton). Also clears the
 * cached several-rows refusal and its one-per-window log, so a test can
 * exercise each scenario from a clean slate.
 */
export function _resetLocalInstanceIdCacheForTests(): void {
  cachedInstanceId = null;
  refusalUntilMs = 0;
  refusalLogged = false;
  refusalRowCount = 0;
}
