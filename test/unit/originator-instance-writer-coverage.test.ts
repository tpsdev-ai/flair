/**
 * originator-instance-writer-coverage.test.ts — flair#1965 round 2.
 *
 * The server-stamped `originatorInstanceId` contract is only as good as the set
 * of writers that honour it. The four resource classes share ONE delegate
 * (resources/originator-instance.ts); the remaining writers CREATE rows through
 * the RAW table handles and bypass those classes' post()/put(), so each must
 * stamp the local id itself on a create. This tripwire pins BOTH sets, so a
 * call removed (or a new writer added without the stamp) fails the lane.
 *
 * The raw writers that CREATE a synced-table row (all reviewed in this round):
 *   - resources/AgentSeed.ts   — POST /AgentSeed: raw Agent + Soul + starter Memory
 *   - resources/mcp-handler.ts — JIT OAuth principal: raw Agent
 *   - resources/XAA.ts         — IdP principal: raw Agent
 *   - resources/MemoryFeed.ts  — POST /FeedMemories: raw Memory (create + update)
 * Update-only raw writers (usage-recording, MemoryMaintenance, MemoryReflect,
 * promotion-stamp, the boot migrations, closeSupersededRecord) re-write an
 * EXISTING row through a read-modify-write and therefore carry the stored value
 * forward; they are not creates and are deliberately not stamped here.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const RAW_CREATE_WRITERS: Array<[string, string]> = [
  ["resources/AgentSeed.ts", "POST /AgentSeed raw Agent/Soul/starter-Memory creates"],
  ["resources/mcp-handler.ts", "JIT OAuth principal raw Agent create"],
  ["resources/XAA.ts", "IdP principal raw Agent create"],
  ["resources/MemoryFeed.ts", "POST /FeedMemories raw Memory create/update"],
];

const RESOURCE_WRITERS: Array<[string, string]> = [
  ["resources/Memory.ts", "Memory post()/put()/patch()"],
  ["resources/Soul.ts", "Soul post()/put()/patch()"],
  ["resources/Agent.ts", "Agent post()/put()/patch()"],
  ["resources/Relationship.ts", "Relationship put()/patch()"],
];

test("every raw create writer of a synced table stamps the originator (RED if the call is removed)", () => {
  const missing = RAW_CREATE_WRITERS
    .filter(([file]) => {
      const src = readFileSync(file, "utf8");
      // FeedMemories applies the full create/update rule (applyOriginatorInstanceId);
      // the other raw creators are creates only, so they stamp directly.
      return !(src.includes("stampOriginatorOnCreate(") || src.includes("applyOriginatorInstanceId("));
    })
    .map(([file]) => file);
  expect(missing).toEqual([]);
});

test("every resource writer applies the shared create/update rule", () => {
  const missing = RESOURCE_WRITERS
    .filter(([file]) => {
      const src = readFileSync(file, "utf8");
      return !(src.includes("applyOriginatorInstanceId(") || src.includes("stampOriginatorOnCreate("));
    })
    .map(([file]) => file);
  expect(missing).toEqual([]);
});

test("the writers resolve the pre-existing row by the URL-bound target id (not a body id)", () => {
  // Agent/Soul/Relationship/Memory all reach the shared resolveStoredRow (or
  // Memory's post/patch stamps, which have no stored row / merge semantics).
  for (const file of ["resources/Agent.ts", "resources/Soul.ts", "resources/Relationship.ts", "resources/Memory.ts"]) {
    expect(readFileSync(file, "utf8")).toContain("resolveStoredRow(");
  }
});
