import { describe, test, expect } from "bun:test";
import {
  parseVerdict, JudgeParseError, buildJudgePrompt, ANSWERABLE_TEMPLATE, PREFERENCE_TEMPLATE, ABSTENTION_TEMPLATE,
} from "../bench/longmemeval/judge";

// The judge must parse a PLAINTEXT exact enum and treat anything it cannot
// resolve as an ERROR — never a silent pass (the fail-open trap the design
// names). These tests pin that boundary: what is accepted, and what MUST throw.

describe("parseVerdict — strict enum, fail-loud", () => {
  test("clean single letters map to the ternary", () => {
    expect(parseVerdict("A", ["A", "B", "C"])).toBe("CORRECT");
    expect(parseVerdict("B", ["A", "B", "C"])).toBe("INCORRECT");
    expect(parseVerdict("C", ["A", "B", "C"])).toBe("NOT_ATTEMPTED");
  });

  test("tolerates light decoration around a single letter", () => {
    expect(parseVerdict(" A ", ["A", "B", "C"])).toBe("CORRECT");
    expect(parseVerdict("A.", ["A", "B", "C"])).toBe("CORRECT");
    expect(parseVerdict("**B**", ["A", "B", "C"])).toBe("INCORRECT");
    expect(parseVerdict("Verdict: C", ["A", "B", "C"])).toBe("NOT_ATTEMPTED");
    expect(parseVerdict("a", ["A", "B", "C"])).toBe("CORRECT"); // case-insensitive
  });

  test("ERRORS on an empty / letterless response (never a silent pass)", () => {
    expect(() => parseVerdict("", ["A", "B", "C"])).toThrow(JudgeParseError);
    expect(() => parseVerdict("the answer looks fine to me", ["A", "B", "C"])).toThrow(JudgeParseError);
  });

  test("ERRORS on two DIFFERENT letters (ambiguous, never guesses)", () => {
    expect(() => parseVerdict("A or B", ["A", "B", "C"])).toThrow(JudgeParseError);
    expect(() => parseVerdict("Between B and C, I'd say...", ["A", "B", "C"])).toThrow(JudgeParseError);
  });

  test("a letter glued inside a word is NOT a verdict", () => {
    // "Correct" contains no standalone A/B/C; must error, not read the 'C'.
    expect(() => parseVerdict("Absolutely correct", ["A", "B", "C"])).toThrow(JudgeParseError);
  });

  test("abstention questions allow only A/B — a C is an ERROR, not a pass", () => {
    expect(parseVerdict("A", ["A", "B"])).toBe("CORRECT");
    expect(parseVerdict("B", ["A", "B"])).toBe("INCORRECT");
    expect(() => parseVerdict("C", ["A", "B"])).toThrow(JudgeParseError);
  });
});

describe("buildJudgePrompt — right rubric per task", () => {
  test("answerable non-preference uses the answerable template with the task rule", () => {
    const p = buildJudgePrompt({ task: "temporal-reasoning", question: "q", answer: "a", response: "r", abstention: false });
    expect(p.allowed).toEqual(["A", "B", "C"]);
    expect(p.prompt).toContain("off-by-one"); // temporal leniency clause ported
    expect(p.prompt).not.toContain("{taskRule}");
  });

  test("knowledge-update carries its ported leniency clause", () => {
    const p = buildJudgePrompt({ task: "knowledge-update", question: "q", answer: "a", response: "r", abstention: false });
    expect(p.prompt).toContain("updated answer");
  });

  test("preference uses the rubric template (allows A/B/C)", () => {
    const p = buildJudgePrompt({ task: "single-session-preference", question: "q", answer: "rubric", response: "r", abstention: false });
    expect(p.prompt).toContain("Rubric:");
    expect(p.allowed).toEqual(["A", "B", "C"]);
  });

  test("abstention uses the unanswerable template and restricts to A/B", () => {
    const p = buildJudgePrompt({ task: "single-session-user", question: "q", answer: "why unanswerable", response: "r", abstention: true });
    expect(p.prompt).toContain("UNANSWERABLE");
    expect(p.allowed).toEqual(["A", "B"]);
  });

  test("no placeholders survive substitution", () => {
    for (const t of ["single-session-user", "multi-session", "temporal-reasoning", "knowledge-update"] as const) {
      const p = buildJudgePrompt({ task: t, question: "Q?", answer: "A", response: "R", abstention: false });
      expect(p.prompt).not.toMatch(/\{(question|answer|response|taskRule)\}/);
    }
  });
});
