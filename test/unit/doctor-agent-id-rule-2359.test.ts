/**
 * doctor-agent-id-rule-2359.test.ts — flair#2359.
 *
 * `flair doctor` reports stored Agent ids that fall outside the shared agent-ID
 * rule, and rewrites nothing. The decision is pure
 * (describeAgentIdRuleFinding in src/doctor-client.ts) so it is tested here
 * without a running instance; test/integration/agent-id-rule-2359.test.ts seeds
 * a real non-conforming row and feeds the real roster through it.
 */
import { describe, it, expect } from "bun:test";
import { describeAgentIdRuleFinding } from "../../src/doctor-client.js";
import { AGENT_ID_RULE } from "../../src/lib/agent-id-rule.js";

describe("flair#2359 — describeAgentIdRuleFinding", () => {
  it("returns null when the roster's ids conform", () => {
    expect(
      describeAgentIdRuleFinding([{ id: "agent-a" }, { id: "Agent_B-2" }, { id: "x".repeat(64) }]),
    ).toBeNull();
  });

  it("reports a seeded non-conforming id, naming the rule and the id", () => {
    const finding = describeAgentIdRuleFinding([{ id: "agent-a" }, { id: "bad.id" }]);
    expect(finding).not.toBeNull();
    expect(finding!.invalidIds).toEqual(["bad.id"]);
    expect(finding!.message).toContain("bad.id");
    expect(finding!.message).toContain(AGENT_ID_RULE);
    expect(finding!.fixHint).toContain("flair agent add");
  });

  it("reports every non-conforming id, sorted", () => {
    const finding = describeAgentIdRuleFinding([{ id: "z.z" }, { id: "ok" }, { id: "a a" }]);
    expect(finding!.invalidIds).toEqual(["a a", "z.z"]);
  });

  it("counts a row with no id as non-conforming, and tolerates an empty roster", () => {
    expect(describeAgentIdRuleFinding([{ id: undefined }])!.invalidIds).toEqual(["undefined"]);
    expect(describeAgentIdRuleFinding([])).toBeNull();
  });
});
