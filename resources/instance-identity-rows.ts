import { databases } from "harper";
import { readableInstanceRows, type InstanceIdentityRow } from "../src/lib/instance-identity-row.js";

/**
 * Every `flair.Instance` row on this instance, or a THROWN error.
 *
 * The ONE strict Instance reader, shared by every server-side reader that needs
 * the whole table: `GET /FederationInstance` / `POST /FederationPair`
 * (resources/Federation.ts, which re-exports this) and the local-instance
 * write-time stamp (resources/instance-identity.ts, flair#1896). It lives in its
 * own module so the write path does not pull the whole Federation resource and
 * its imports into every process that writes a record; the reader itself is a
 * single implementation, never copied.
 *
 * The readers used to take the first row `search()` yielded. `search()` order is
 * not a fact about an identity: on a table with two rows one reader reported one
 * identity and a pairing peer was handed the other, and which was which depended
 * on the table's internal ordering (flair#1883 round 3).
 *
 * A read that FAILS must not look like a table with no rows: the callers treat
 * it as its own outcome, because only a SUCCESSFUL read of zero rows may mint an
 * identity (and the write-time stamp resolves to null).
 *
 * And neither must a row the reader cannot NAME (flair#1883 round 4): an entry
 * without a usable id used to be skipped here, so a table serving one bad entry
 * (or a good one beside it) read as "the rows I could name" — possibly zero — and
 * the GET's create branch could mint a second identity from a read that never
 * saw the table. `readableInstanceRows` throws instead, which the callers map to
 * 5xx / a null, uncached local id.
 */
export async function readAllInstanceRows(): Promise<InstanceIdentityRow[]> {
  const raw: unknown[] = [];
  for await (const i of (databases as any).flair.Instance.search()) raw.push(i);
  // Throws on the first entry without a usable id — before anything is
  // normalized or reported.
  return readableInstanceRows(raw).map((i) => ({
    id: i.id,
    role: i.role ?? null,
    publicKey: i.publicKey ?? null,
    status: i.status ?? null,
    createdAt: i.createdAt ?? null,
  }));
}
