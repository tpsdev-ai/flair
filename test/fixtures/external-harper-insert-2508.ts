/**
 * external-harper-insert-2508.ts — subprocess fixture for
 * test/integration/embedding-space-scan-order-2508.test.ts (flair#2508).
 *
 * Run with plain `bun` and HARPER_HTTP_URL / HARPER_OPS_URL set, so the REAL
 * `startHarper` takes its external branch (test/helpers/harper-lifecycle.ts).
 * It then attempts one Memory row insert through the 2508 test's own-instance
 * check and prints one `RESULT <json>` line: the returned instance's shape and
 * the refusal message, or null when nothing refused the insert.
 */
import { startHarper } from "../helpers/harper-lifecycle";
import { insertMemoryRows } from "../helpers/own-harper-instance";

const h = await startHarper();
let refusal: string | null = null;
try {
  const now = new Date().toISOString();
  await insertMemoryRows(h, [
    { id: "never-written", agentId: "scan-order-agent", content: "never written", embeddingModel: "other-engine:x", createdAt: now, updatedAt: now },
  ]);
} catch (err) {
  refusal = err instanceof Error ? err.message : String(err);
}
console.log(`RESULT ${JSON.stringify({ external: h.external, process: h.process === null ? null : "spawned", installDir: h.installDir, refusal })}`);
