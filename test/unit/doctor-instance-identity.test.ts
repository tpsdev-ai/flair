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
  INSTANCE_ROW_PRUNE_REMEDY,
  PAIR_INITIATOR_ROLE,
  instanceIdentityFindingLines,
  instanceIdentityFindings,
  instanceIdentityLines,
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

  it("reports the multi-row state with the rows and the pruning command that DELETES", () => {
    const findings = instanceIdentityFindings({ rows: [SPOKE_ROW, HUB_ROW], roleNames: [] });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("instance-multiple-rows");
    expect(findings[0].status).toBe("fail");
    expect(findings[0].detail).toContain(SPOKE_ROW.id);
    expect(findings[0].detail).toContain(HUB_ROW.id);
    expect(findings[0].detail).toContain("role=spoke");
    expect(findings[0].remedy).toBe(INSTANCE_ROW_PRUNE_REMEDY);
    // `prune` is a DRY RUN without --apply: the remedy names both, because the
    // bare command deletes nothing and reads as a successful prune.
    expect(findings[0].remedy).toContain(INSTANCE_ROW_PRUNE_COMMAND);
    expect(findings[0].remedy).toContain("dry run");
    expect(findings[0].remedy).toContain("--apply");
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

  it("reports BOTH mismatches when both are present, prune FIRST", () => {
    const findings = instanceIdentityFindings({
      rows: [SPOKE_ROW, HUB_ROW],
      roleNames: [PAIR_INITIATOR_ROLE],
    });
    expect(findings.map((f) => f.code)).toEqual(["instance-multiple-rows", "pair-role-not-hub"]);
    // The remedies run in the order they are printed: `init --remote` refuses
    // while several rows exist, so the pair-role remedy names the prune as its
    // prerequisite instead of sending the operator into that refusal.
    expect(findings[0].remedy).toContain("--apply");
    expect(findings[1].remedy).toContain(INSTANCE_ROW_PRUNE_COMMAND);
    expect(findings[1].remedy).toContain("--apply");
    expect(findings[1].remedy.indexOf(INSTANCE_ROW_PRUNE_COMMAND)).toBeLessThan(
      findings[1].remedy.indexOf("flair init --remote"),
    );
  });

  it("keeps the pair-role remedy to the one command when there are not several rows", () => {
    const findings = instanceIdentityFindings({ rows: [SPOKE_ROW], roleNames: [PAIR_INITIATOR_ROLE] });
    expect(findings[0].remedy).toBe("flair init --remote");
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
    expect(remedy).toBe(`Fix: ${INSTANCE_ROW_PRUNE_REMEDY}`);
  });
});

describe("instanceIdentityLines — what doctor prints: the findings AND the state", () => {
  it("prints the row finding AND the pairing-role UNVERIFIED status when the roles were unreadable", () => {
    // flair#1883 round 5: doctor printed the summary only when there was NO
    // finding, so several rows AND an unreadable role list reported the rows and
    // said nothing about the pairing-role check that never ran.
    const lines = instanceIdentityLines({ rows: [SPOKE_ROW, HUB_ROW], roleNames: null });

    expect(lines.map((l) => l.level)).toEqual(["fail", "warn"]);
    expect(lines[0].text).toContain("Instance identity: ");
    expect(lines[0].text).toContain(SPOKE_ROW.id);
    expect(lines[0].text).toContain(HUB_ROW.id);
    expect(lines[0].fix).toContain("Fix: ");
    expect(lines[1].text).toContain(PAIR_INITIATOR_ROLE);
    expect(lines[1].text).toContain("UNVERIFIED");
    expect(lines[1].text).toContain("pairing-role check");
  });

  it("prints one ok line for a consistent hub, and makes no UNVERIFIED claim", () => {
    const lines = instanceIdentityLines({ rows: [HUB_ROW], roleNames: [PAIR_INITIATOR_ROLE] });

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("ok");
    expect(lines[0].text).toBe("Instance identity: one row, role=hub");
    expect(lines[0].fix).toBeUndefined();
  });

  it("keeps the row facts with the UNVERIFIED status when there is no finding", () => {
    const lines = instanceIdentityLines({ rows: [HUB_ROW], roleNames: null });

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].text).toContain("one row, role=hub");
    expect(lines[0].text).toContain("UNVERIFIED");
  });

  it("carries the finding and its fix, and no UNVERIFIED line, when the roles WERE read", () => {
    const lines = instanceIdentityLines({ rows: [SPOKE_ROW, HUB_ROW], roleNames: [] });

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("fail");
    expect(lines[0].fix).toContain("--apply");
    expect(lines.some((l) => l.text.includes("UNVERIFIED"))).toBe(false);
  });

  it("prints the pair-role finding and no UNVERIFIED line when the roles were read", () => {
    const lines = instanceIdentityLines({ rows: [SPOKE_ROW], roleNames: [PAIR_INITIATOR_ROLE] });

    expect(lines.map((l) => l.level)).toEqual(["fail"]);
    expect(lines[0].text).toContain("not a hub");
    expect(lines.some((l) => l.text.includes("UNVERIFIED"))).toBe(false);
  });

  it("prints one line per finding when both mismatches are present, the row finding first", () => {
    const lines = instanceIdentityLines({ rows: [SPOKE_ROW, HUB_ROW], roleNames: [PAIR_INITIATOR_ROLE] });

    expect(lines.map((l) => l.level)).toEqual(["fail", "fail"]);
    expect(lines[0].text).toContain("Instance rows");
    expect(lines[1].text).toContain("not a hub");
  });
});
