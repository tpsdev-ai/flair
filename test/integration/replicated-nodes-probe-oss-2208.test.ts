import { expect, test } from "bun:test";
import { HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeReplicationSupport } from "../helpers/replicated-nodes.js";

test("the open-source Harper probe reaches replication dispatch", async () => {
  const result = await probeReplicationSupport();
  expect(result.supported).toBe(false);
  expect(result.error).toMatch(/^set_configuration\(replicated:true\) → HTTP /);
  expect(result.error).toContain("Replication not implemented.");
}, HARPER_START_BUDGET_MS + DEFAULT_PROBE_TIMEOUT_MS + HARPER_STOP_BUDGET_MS);
