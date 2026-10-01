// flair#2141 S1b — the skills manifest resolver (resources/skill-manifest.ts).
// The bootstrap payload cases live in
// test/unit-isolated/memory-bootstrap-scoping.test.ts; these pin the pure rules.
import { describe, expect, test } from "bun:test";
import {
  receivesOrgSkills,
  resolvableSkillRows,
  resolveSkillManifest,
  resolveSkillRef,
  type SkillManifestEntry,
  type SkillRow,
} from "../../resources/skill-manifest.ts";

const AGENT = "agent-a";

function skillRow(id: string, agentId: string, name: string, extra: Record<string, unknown> = {}): SkillRow {
  return {
    id,
    agentId,
    tags: ["skill"],
    metadata: JSON.stringify({ name }),
    ...extra,
  };
}

function assignment(value: string, priority = "standard", source?: string) {
  return {
    key: "skill-assignment",
    value,
    priority,
    metadata: source ? JSON.stringify({ source }) : undefined,
  };
}

describe("resolveSkillRef — a name resolves to the agent's own skill row only", () => {
  test("the agent's own row resolves, even beside a teammate row with an older createdAt", () => {
    const rows = [
      skillRow("teammate-old", "agent-b", "deploy", { createdAt: "2020-01-01T00:00:00.000Z" }),
      skillRow("own", AGENT, "deploy", { createdAt: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(resolveSkillRef("deploy", rows, AGENT)).toEqual({ kind: "resolved", skillId: "own" });
  });

  test("a teammate's shared row with the name and an older createdAt does not resolve: the name is unresolved", () => {
    const rows = [
      skillRow("teammate-old", "agent-b", "deploy", { createdAt: "2020-01-01T00:00:00.000Z", visibility: "shared" }),
      skillRow("teammate-new", "agent-c", "deploy", { createdAt: "2026-02-01T00:00:00.000Z", visibility: "shared" }),
    ];
    expect(resolveSkillRef("deploy", rows, AGENT).kind).toBe("unresolved");
  });

  test("two own rows with the name are ambiguous, whatever their createdAt", () => {
    const rows = [
      skillRow("own-2", AGENT, "deploy", { createdAt: "2026-02-01T00:00:00.000Z" }),
      skillRow("own-1", AGENT, "deploy", { createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const ref = resolveSkillRef("deploy", rows, AGENT);
    expect(ref.kind).toBe("ambiguous");
    expect((ref as any).candidates).toEqual(["own-1", "own-2"]);
  });

  test("no row with the name is unresolved", () => {
    const rows = [skillRow("x", AGENT, "other")];
    expect(resolveSkillRef("deploy", rows, AGENT).kind).toBe("unresolved");
  });
});

describe("resolvableSkillRows — the rows passed to resolveSkillRef", () => {
  const readable = (row: any) => row.agentId === AGENT || row.visibility !== "private";
  const NOW = Date.parse("2026-06-01T00:00:00.000Z");

  test("keeps a readable live skill row and drops unreadable, non-skill, archived, closed and expired rows", () => {
    const rows: SkillRow[] = [
      skillRow("keep", "agent-b", "deploy"),
      { ...skillRow("private-teammate", "agent-b", "deploy"), visibility: "private" } as SkillRow,
      { ...skillRow("not-a-skill", "agent-b", "deploy"), tags: ["note"] },
      skillRow("archived", "agent-b", "deploy", { archived: true }),
      skillRow("closed", "agent-b", "deploy", { validTo: "2026-05-01T00:00:00.000Z" }),
      skillRow("expired", "agent-b", "deploy", { expiresAt: "2026-05-01T00:00:00.000Z" }),
      skillRow("future-close", "agent-b", "deploy", { validTo: "2026-07-01T00:00:00.000Z" }),
    ];
    const kept = resolvableSkillRows(rows, readable, NOW).map((r) => r.id);
    expect(kept).toEqual(["keep", "future-close"]);
  });
});

describe("resolveSkillManifest — winners in skills; refused, superseded, unresolved and ambiguous in diagnostics", () => {
  const rows = [
    skillRow("row-alpha", AGENT, "alpha"),
    skillRow("row-beta", AGENT, "beta"),
    skillRow("row-gamma", AGENT, "gamma"),
  ];

  test("a resolved winner ships as { name, skillId, scope, priority, source } and nothing else", () => {
    const { skills, diagnostics } = resolveSkillManifest([assignment("alpha", "high", "npm:@x/alpha@1.0.0")], rows, AGENT);
    expect(diagnostics).toEqual([]);
    expect(skills).toEqual([
      { name: "alpha", skillId: "row-alpha", scope: "own", priority: "high", source: "npm:@x/alpha@1.0.0" },
    ]);
    expect(Object.keys(skills[0])).toEqual(["name", "skillId", "scope", "priority", "source"]);
  });

  test("refused (tie and non-durable source), superseded, unresolved and ambiguous appear only in diagnostics", () => {
    const ambiguousRows = [...rows, skillRow("row-delta-1", AGENT, "delta"), skillRow("row-delta-2", AGENT, "delta")];
    const { skills, diagnostics } = resolveSkillManifest([
      assignment("alpha", "high"),
      assignment("alpha", "low"),                         // superseded by the high one
      assignment("beta", "standard", "npm:@x/beta@1"),
      assignment("beta", "standard", "npm:@x/beta@2"),    // equal-priority tie → both refused
      assignment("gamma", "standard", "/tmp/scratch/gamma/SKILL.md"), // non-durable source → refused
      assignment("missing"),                               // no skill row → unresolved
      assignment("delta"),                                 // two own rows → ambiguous
    ], ambiguousRows, AGENT);

    expect(skills.map((s) => s.name)).toEqual(["alpha"]);
    const byName = (name: string) => diagnostics.filter((d) => d.name === name).map((d) => d.decision).sort();
    expect(byName("alpha")).toEqual(["superseded"]);
    expect(byName("beta")).toEqual(["refused", "refused"]);
    expect(byName("gamma")).toEqual(["refused"]);
    expect(byName("missing")).toEqual(["unresolved"]);
    expect(byName("delta")).toEqual(["ambiguous"]);
    expect(diagnostics.find((d) => d.name === "delta")?.candidates).toEqual(["row-delta-1", "row-delta-2"]);
  });

  test("the same inputs in a different order produce the same lists", () => {
    const inputs = [assignment("beta"), assignment("alpha"), assignment("missing"), assignment("gamma", "low")];
    const first = resolveSkillManifest(inputs, rows, AGENT);
    const second = resolveSkillManifest([...inputs].reverse(), [...rows].reverse(), AGENT);
    expect(second).toEqual(first);
    expect(first.skills.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
  });
});

// flair#2141 S1 — org-scope assignments and opt-outs.
describe("resolveSkillManifest — org assignments and opt-outs (flair#2141 S1)", () => {
  const LOCAL = "instance-local";
  const orgRows = [skillRow("org-row", "agent-ops", "using-flair", { visibility: "shared" })];
  const org = (assignments: Array<Record<string, unknown>>, instanceId: string | null = LOCAL) =>
    ({ assignments, rows: orgRows, instanceId });
  const usingFlair = { skillName: "using-flair", skillRef: "org-row", priority: "standard" };
  // An opt-out Soul row; `stamp` is its originatorInstanceId (none when null).
  const optOut = (stamp: string | null = LOCAL, optOutValue: unknown = true) => ({
    key: "skill-assignment", value: "using-flair", metadata: JSON.stringify({ optOut: optOutValue }),
    ...(stamp === null ? {} : { originatorInstanceId: stamp }),
  });
  const orgEntry: SkillManifestEntry = { name: "using-flair", skillId: "org-row", scope: "org", priority: "standard", source: null };

  test("an agent with no own assignment gets the org skill: scope org, its skillRef as skillId", () => {
    expect(resolveSkillManifest([], [], AGENT, org([usingFlair]))).toEqual({ skills: [orgEntry], diagnostics: [] });
  });

  test("a higher-priority own assignment wins; the org assignment is superseded, in diagnostics", () => {
    const own = [skillRow("own-row", AGENT, "using-flair")];
    const { skills, diagnostics } = resolveSkillManifest([assignment("using-flair", "high")], own, AGENT, org([usingFlair]));
    expect(skills).toEqual([{ name: "using-flair", skillId: "own-row", scope: "own", priority: "high", source: null }]);
    expect(diagnostics.map((d) => `${d.scope}:${d.decision}`)).toEqual(["org:superseded"]);
  });

  test("an own and an org assignment at equal priority tie: both refused, neither in skills", () => {
    const own = [skillRow("own-row", AGENT, "using-flair")];
    const { skills, diagnostics } = resolveSkillManifest([assignment("using-flair")], own, AGENT, org([usingFlair]));
    expect(skills).toEqual([]);
    expect(diagnostics.map((d) => `${d.scope}:${d.decision}`)).toEqual(["org:refused", "own:refused"]);
  });

  test("an opt-out stamped by this instance removes the org skill and is not itself a candidate", () => {
    expect(resolveSkillManifest([optOut()], [], AGENT, org([usingFlair]))).toEqual({ skills: [], diagnostics: [] });
  });

  test("an opt-out leaves the agent's own assignment of the name in place", () => {
    const own = [skillRow("own-row", AGENT, "using-flair")];
    const { skills, diagnostics } = resolveSkillManifest([assignment("using-flair"), optOut()], own, AGENT, org([usingFlair]));
    expect(skills).toEqual([{ name: "using-flair", skillId: "own-row", scope: "own", priority: "standard", source: null }]);
    expect(diagnostics).toEqual([]);
  });

  test("an opt-out applies only when its originatorInstanceId is this instance's id", () => {
    expect(resolveSkillManifest([optOut("instance-peer")], [], AGENT, org([usingFlair])).skills).toEqual([orgEntry]);
    expect(resolveSkillManifest([optOut(null)], [], AGENT, org([usingFlair])).skills).toEqual([orgEntry]);
    expect(resolveSkillManifest([optOut(null)], [], AGENT, org([usingFlair], null)).skills).toEqual([]);
  });

  test("a non-boolean optOut is refused in diagnostics and neither removes the org skill nor loads", () => {
    const { skills, diagnostics } = resolveSkillManifest([optOut(LOCAL, "true")], [], AGENT, org([usingFlair]));
    expect(skills).toEqual([orgEntry]);
    expect(diagnostics).toEqual([{
      name: "using-flair", scope: "own", priority: "standard", source: null,
      decision: "refused", reason: "metadata.optOut is not a boolean",
    }]);
  });

  test("an org skillRef outside the resolvable rows is unresolved; an own row with the name does not stand in for it", () => {
    const own = [skillRow("own-row", AGENT, "using-flair")];
    const { skills, diagnostics } = resolveSkillManifest(
      [], own, AGENT, org([{ skillName: "using-flair", skillRef: "missing-row", priority: "standard" }]),
    );
    expect(skills).toEqual([]);
    expect(diagnostics.map((d) => `${d.scope}:${d.decision}`)).toEqual(["org:unresolved"]);
  });
});

describe("receivesOrgSkills — the target Agent record decides (flair#2141 S1)", () => {
  test("an agent record, with kind and status absent or agent and active, receives org skills", () => {
    expect(receivesOrgSkills({ id: "a" })).toBe(true);
    expect(receivesOrgSkills({ id: "a", kind: "agent", status: "active" })).toBe(true);
  });

  test("a human, a surface principal, a deactivated agent and a missing record do not", () => {
    expect(receivesOrgSkills({ id: "h", kind: "human" })).toBe(false);
    expect(receivesOrgSkills({ id: "s", kind: "surface" })).toBe(false);
    expect(receivesOrgSkills({ id: "d", status: "deactivated" })).toBe(false);
    expect(receivesOrgSkills(null)).toBe(false);
    expect(receivesOrgSkills(undefined)).toBe(false);
  });
});
