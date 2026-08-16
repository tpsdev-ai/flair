/**
 * ingest.ts — write session history into Flair, per-event.
 *
 * The single ingestion path both eval layers share (Kern's #1216 design). One
 * Memory per SessionEvent — the granularity Flair itself uses in production
 * (`memory_service.py` writes one Memory per event) and the locked #1216
 * decision. If Layer 1 and Layer 2 ingested differently, a discrepancy between
 * them would be a silent confound; this module is the one place the mapping
 * lives, so "how exactly are sessions written to Flair?" has a single answer.
 *
 * The write is a PUT /Memory/<id> with the same body the recall-harness uses
 * (id, agentId, content, durability, createdAt) via the shared signed-fetch —
 * so the memories this produces are byte-identical to what the existing,
 * deterministic harness produces.
 */
import type { BenchClient, IngestOptions, IngestResult, SessionHistory } from "./types.js";
import { signedFetch } from "./signed-fetch.js";

function toIso(t: string | number | undefined): { iso: string; synthetic: boolean } {
  if (t === undefined) return { iso: new Date().toISOString(), synthetic: true };
  if (typeof t === "number") return { iso: new Date(t).toISOString(), synthetic: false };
  return { iso: t, synthetic: false };
}

/**
 * Write every event of every session as its own Memory, scoped to
 * `client.agent.id` (Kern's `userId`). Timestamps are preserved verbatim
 * (temporal ordering survives). Returns the written ids in order plus whether
 * any timestamp had to be synthesised.
 *
 * Throws on the first failed write with the HTTP status + body — a seeding
 * failure must surface loudly, never degrade into a low recall number that
 * looks like a retrieval regression.
 */
export async function ingestSessionHistory(
  client: BenchClient,
  sessions: SessionHistory[],
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const granularity = opts.granularity ?? "per-event";
  if (granularity !== "per-event") {
    throw new Error(`ingestSessionHistory: only "per-event" granularity is implemented (got "${granularity}"). Any other granularity is a labelled ablation, not a default — implement it explicitly.`);
  }
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const { harper, agent } = client;

  // Flatten to a single ordered event stream. One Memory per event.
  const events = sessions.flatMap((s) => s.events);
  const ids: string[] = [];
  let syntheticTimestamps = false;

  const start = performance.now();
  for (let i = 0; i < events.length; i += concurrency) {
    const batch = events.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (ev) => {
        const { iso, synthetic } = toIso(ev.createdAt);
        if (synthetic) syntheticTimestamps = true;
        const path = `/Memory/${ev.id}`;
        const res = await signedFetch(harper, agent, "PUT", path, {
          id: ev.id,
          agentId: agent.id,
          content: ev.content,
          durability: ev.durability ?? "standard",
          createdAt: iso,
        });
        if (!res.ok) {
          throw new Error(`ingest event ${ev.id} failed: HTTP ${res.status} ${JSON.stringify(res.body ?? null).slice(0, 400)}`);
        }
      }),
    );
    // Preserve write order in the returned id list regardless of Promise.all
    // resolution order.
    for (const ev of batch) ids.push(ev.id);
  }
  const elapsedMs = performance.now() - start;

  return { written: ids.length, ids, syntheticTimestamps, elapsedMs };
}
