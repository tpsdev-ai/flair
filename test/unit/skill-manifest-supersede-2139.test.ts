// flair#2139 S2 completion — an unversioned org skillRef resolves to the
// lineage's current LIVE SUCCESSOR (resources/skill-manifest.ts). A skill update
// supersedes into a fresh physical Memory row that carries the referenced id as
// its `skillSubjectId`; a reference naming the now-closed predecessor must
// resolve forward, not go unresolved. Assignment authority and precedence are
// unchanged.
import { describe, expect, test } from "bun:test";
import { resolveSkillManifest, type SkillManifestEntry } from "../../resources/skill-manifest.ts";

const AGENT = "agent-a";
const LOCAL = "instance-local";

function skillRow(id: string, agentId: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, agentId, tags: ["skill"], metadata: JSON.stringify({ name }), ...extra };
}

const org = (skillRef: string, rows: any[]) => ({
  assignments: [{ skillName: "using-flair", skillRef, priority: "standard" }],
  rows,
  instanceId: LOCAL,
});

const orgEntry = (skillId: string, priority = "standard"): SkillManifestEntry =>
  ({ name: "using-flair", skillId, scope: "org", priority, source: null });

describe("resolveOrgRef — a superseded skillRef resolves to the live successor (flair#2139 S2)", () => {
  test("a ref naming the closed predecessor resolves to the successor carrying its subject", () => {
    const successor = skillRow("successor-1", "agent-ops", "using-flair", { visibility: "shared", skillSubjectId: "physical-1" });
    expect(resolveSkillManifest([], [], AGENT, org("physical-1", [successor]))).toEqual({
      skills: [orgEntry("successor-1")], diagnostics: [],
    });
  });

  test("a ref naming a live row still resolves by id, not by subject", () => {
    const live = skillRow("physical-1", "agent-ops", "using-flair", { visibility: "shared", skillSubjectId: "physical-1" });
    expect(resolveSkillManifest([], [], AGENT, org("physical-1", [live])).skills).toEqual([orgEntry("physical-1")]);
  });

  test("a ref with neither a live id nor a live successor is unresolved", () => {
    const other = skillRow("other-1", "agent-ops", "using-flair", { visibility: "shared", skillSubjectId: "other-1" });
    const { skills, diagnostics } = resolveSkillManifest([], [], AGENT, org("gone-1", [other]));
    expect(skills).toEqual([]);
    expect(diagnostics.map((d) => `${d.scope}:${d.decision}`)).toEqual(["org:unresolved"]);
  });
});
