// flair#2141 S1b — the skills manifest resolver (resources/skill-manifest.ts).
// The bootstrap payload cases live in
// test/unit-isolated/memory-bootstrap-scoping.test.ts; these pin the pure rules.
import { describe, expect, test } from "bun:test";
import {
  resolvableSkillRows,
  resolveSkillManifest,
  resolveSkillRef,
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
