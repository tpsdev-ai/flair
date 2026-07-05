import { databases } from "@harperfast/harper";

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
 */
let cachedInstanceId: string | null = null;

export async function localInstanceId(): Promise<string | null> {
  if (cachedInstanceId) return cachedInstanceId;
  try {
    for await (const row of (databases as any).flair.Instance.search()) {
      if (row?.id) {
        cachedInstanceId = row.id;
      }
      break; // exactly one row expected — this instance's own identity
    }
  } catch {
    // Instance table not present (test env / not yet migrated) — no local id.
  }
  return cachedInstanceId;
}

/**
 * Test-only: force re-resolution on the next localInstanceId() call. The
 * module-level cache otherwise persists across test files that share the
 * same `bun test` process (same collision class documented in
 * memory-integrity.test.ts re: the Memory class singleton).
 */
export function _resetLocalInstanceIdCacheForTests(): void {
  cachedInstanceId = null;
}
