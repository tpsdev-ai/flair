// Run separately on each revision: node --expose-gc test/bench/bm25-metadata-retention.mjs
// Synthetic retained-heap measurement, not a production RSS forecast.
import { Bm25Index } from "../../dist/resources/bm25-index.js";
const count = 20000;
global.gc();
const before = process.memoryUsage();
const index = new Bm25Index();
let bodyBytes = 0;
for (let i = 0; i < count; i++) {
  const content = Array.from({ length: 100 }, (_, w) => `term${(i * 7 + w) % 2000}`).join(" ");
  bodyBytes += Buffer.byteLength(content);
  index.upsert({ id: `memory-${i}`, agentId: "reader", visibility: "shared", content, tags: ["ops"] });
}
global.gc();
const after = process.memoryUsage();
console.log(JSON.stringify({ documents: index.size, postings: index.postingCount, bodyBytes,
  heapUsedDelta: after.heapUsed - before.heapUsed, rssDelta: after.rss - before.rss }));
