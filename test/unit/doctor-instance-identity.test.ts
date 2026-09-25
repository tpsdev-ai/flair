/**
 * doctor's instance-identity findings (flair#1883).
 *
 * `flair doctor` reports two identity mismatches, each with the ONE command
 * that fixes it: more than one `Instance` row (no canonical identity), and the
 * `flair_pair_initiator` role present on an instance that is not a hub. Both
 * are pure decisions over (rows, role names), asserted here for every state —
 * including the two that must stay SILENT: a consistent instance, and a read
 * that did not happen (a check that cannot see the state must not report green).
 */

import { describe, it, expect } from "bun:test";
import {
  INSTANCE_ROW_PRUNE_COMMAND,
  PAIR_INITIATOR_ROLE,
  instanceIdentityFindingLines,
  instanceIdentityFindings,
  type InstanceIdentityRow,
} from "../../src/lib/instance-identity-row.js";

const HUB_ROW: InstanceIdentityRow = {
  id: "flair_aaaaaaaa",
  role: "hub",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const SPOKE_ROW: InstanceIdentityRow = {
  id: "flair_bbbbbbbb",
  role: "spoke",
  createdAt: "2026-09-02T00:00:00.000Z",
};

describe("instanceIdentityFindings", () => {
  it("reports nothing on a consistent hub", () => {
    expect(instanceIdentityFindings({ rows: [HUB_ROW], roleNames: [PAIR_INITIATOR_ROLE] })).toEqual([]);
  });

  it("reports nothing on a consistent spoke (no pairing role)", () => {
    expect(instanceIdentityFindings({ rows: [SPOKE_ROW], roleNames: ["flair_agent"] })).toEqual([]);
  });

  it("reports nothing when the Instance read did not happen", () => {
    expect(instanceIdentityFindings({ rows: null, roleNames: [PAIR_INITIATOR_ROLE] })).toEqual([]);
  });

  it("reports the multi-row state with the rows and the pruning command", () => {
    const findings = instanceIdentityFindings({ rows: [SPOKE_ROW, HUB_ROW], roleNames: [] });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("instance-multiple-rows");
    expect(findings[0].status).toBe("fail");
    expect(findings[0].detail).toContain(SPOKE_ROW.id);
    expect(findings[0].detail).toContain(HUB_ROW.id);
    expect(findings[0].detail).toContain("role=spoke");
    expect(findings[0].remedy).toBe(`${INSTANCE_ROW_PRUNE_COMMAND} --keep <id>`);
  });

  it("reports the pairing role on a spoke, with the command that fixes it", () => {
    const findings = instanceIdentityFindings({ rows: [SPOKE_ROW], roleNames: [PAIR_INITIATOR_ROLE] });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("pair-role-not-hub");
    expect(findings[0].detail).toContain(PAIR_INITIATOR_ROLE);
    expect(findings[0].detail).toContain("not a hub");
    expect(findings[0].remedy).toBe("flair init --remote");
  });

  it("reports the pairing role when there is no identity row at all", () => {
    const findings = instanceIdentityFindings({ rows: [], roleNames: [PAIR_INITIATOR_ROLE] });
    expect(findings.map((f) => f.code)).toEqual(["pair-role-not-hub"]);
    expect(findings[0].detail).toContain("no Instance row");
  });

  it("reports BOTH mismatches when both are present", () => {
    const findings = instanceIdentityFindings({
      rows: [SPOKE_ROW, HUB_ROW],
      roleNames: [PAIR_INITIATOR_ROLE],
    });
    expect(findings.map((f) => f.code)).toEqual(["instance-multiple-rows", "pair-role-not-hub"]);
  });

  it("does not claim anything about roles it could not read", () => {
    const findings = instanceIdentityFindings({ rows: [SPOKE_ROW], roleNames: null });
    expect(findings).toEqual([]);
  });

  it("keeps reporting the multi-row state when the role list could not be read", () => {
    const findings = instanceIdentityFindings({ rows: [SPOKE_ROW, HUB_ROW], roleNames: null });
    expect(findings.map((f) => f.code)).toEqual(["instance-multiple-rows"]);
  });

  it("matches the pairing role name regardless of case or spacing", () => {
    const findings = instanceIdentityFindings({ rows: [SPOKE_ROW], roleNames: [" Flair_Pair_Initiator "] });
    expect(findings.map((f) => f.code)).toEqual(["pair-role-not-hub"]);
  });
});

describe("instanceIdentityFindingLines", () => {
  it("renders the headline and the fix", () => {
    const [finding] = instanceIdentityFindings({ rows: [SPOKE_ROW, HUB_ROW], roleNames: [] });
    const [headline, remedy] = instanceIdentityFindingLines(finding);
    expect(headline).toBe(`Instance identity: ${finding.detail}`);
    expect(remedy).toBe(`Fix: ${INSTANCE_ROW_PRUNE_COMMAND} --keep <id>`);
  });
});
