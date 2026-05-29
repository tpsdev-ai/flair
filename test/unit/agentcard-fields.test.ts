import { describe, test, expect } from "bun:test";
import {
  readSoulKind,
  readSoulContent,
  selectPublicDescription,
  selectPublicSkills,
} from "../../resources/agentcard-fields";

/**
 * Tests for what the public (unauthenticated) AgentCard exposes — ops-vz6j.
 *
 * `GET /AgentCard/{id}` bypasses auth (A2A spec). The prior code fell back to
 * publishing the first soul with ANY content as the description when no
 * explicit kind="description" soul existed — leaking arbitrary private souls
 * (internal notes, prompt fragments, credential reminders) on a public surface.
 *
 * The central guard here: an agent with private souls but NO description soul
 * must publish an EMPTY description, never one of those private souls.
 */

describe("selectPublicDescription", () => {
  test("publishes an explicit kind=description soul", () => {
    const souls = [
      { kind: "note", content: "INTERNAL: do not ship" },
      { kind: "description", content: "Strategic cofounder agent." },
    ];
    expect(selectPublicDescription(souls)).toBe("Strategic cofounder agent.");
  });

  test("SECURITY: no description soul → empty string, never a private soul (ops-vz6j)", () => {
    const souls = [
      { kind: "note", content: "INTERNAL reminder: rotate the admin pass" },
      { kind: "prompt", content: "You have access to the production keys at..." },
      { kind: "capability", content: "code-review" },
    ];
    const out = selectPublicDescription(souls);
    expect(out).toBe("");
    expect(out).not.toContain("INTERNAL");
    expect(out).not.toContain("production keys");
  });

  test("SECURITY: empty description soul does not fall back to a private soul", () => {
    const souls = [
      { kind: "description", content: "   " },
      { kind: "note", content: "private internal note" },
    ];
    expect(selectPublicDescription(souls)).toBe("");
  });

  test("no souls at all → empty string", () => {
    expect(selectPublicDescription([])).toBe("");
  });

  test("legacy soul shape (key/value) is honored for the description kind", () => {
    const souls = [{ key: "description", value: "Legacy-shaped description." }];
    expect(selectPublicDescription(souls)).toBe("Legacy-shaped description.");
  });
});

describe("selectPublicSkills", () => {
  test("publishes only kind=capability souls", () => {
    const souls = [
      { kind: "capability", content: "strategy" },
      { kind: "capability", content: "code-review" },
      { kind: "note", content: "secret-model: gpt-x at internal-endpoint" },
      { kind: "description", content: "public description" },
    ];
    expect(selectPublicSkills(souls)).toEqual(["strategy", "code-review"]);
  });

  test("SECURITY: a non-capability soul is never published as a skill", () => {
    const skills = selectPublicSkills([
      { kind: "credentials", content: "token=abc123" },
      { kind: "note", content: "internal" },
    ]);
    expect(skills).toEqual([]);
  });

  test("filters out empty-content capability souls", () => {
    const souls = [
      { kind: "capability", content: "strategy" },
      { kind: "capability", content: "  " },
    ];
    expect(selectPublicSkills(souls)).toEqual(["strategy"]);
  });
});

describe("soul field readers", () => {
  test("readSoulKind prefers kind, falls back to key, lowercases + trims", () => {
    expect(readSoulKind({ kind: "  Description " })).toBe("description");
    expect(readSoulKind({ key: "Capability" })).toBe("capability");
    expect(readSoulKind({})).toBe("");
  });

  test("readSoulContent prefers content, falls back to value, trims", () => {
    expect(readSoulContent({ content: "  hello " })).toBe("hello");
    expect(readSoulContent({ value: "legacy" })).toBe("legacy");
    expect(readSoulContent({})).toBe("");
  });
});
