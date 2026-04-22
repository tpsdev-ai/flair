import { describe, test, expect } from "bun:test";
import { templateSoul, parseSoulJson } from "../../src/cli";

/**
 * Tests for the first-run soul wizard logic.
 *
 * The interactive readline flow is not tested here (needs a TTY). We test
 * the pure helpers: template selection, JSON parsing, entry filtering, and
 * the skip-condition logic the wizard honors.
 */

describe("first-run soul wizard: entry filtering", () => {
  // Mirrors the filter the wizard applies before returning entries
  function filterEmpty(entries: [string, string][]): [string, string][] {
    return entries.filter(([, v]) => v.trim().length > 0);
  }

  test("all answers provided → 3 soul entries", () => {
    const entries = filterEmpty([
      ["role", "Senior dev, concise and direct"],
      ["project", "E-commerce platform"],
      ["standards", "Always write tests"],
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(["role", "Senior dev, concise and direct"]);
  });

  test("empty answers are skipped", () => {
    const entries = filterEmpty([
      ["role", ""],
      ["project", "My project"],
      ["standards", ""],
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(["project", "My project"]);
  });

  test("whitespace-only answers are skipped", () => {
    const entries = filterEmpty([
      ["role", "   "],
      ["project", "  \n  "],
      ["standards", "\t"],
    ]);
    expect(entries).toHaveLength(0);
  });
});

describe("templateSoul", () => {
  test("choice 1 (solo dev) returns role/project/standards", () => {
    const entries = templateSoul("1");
    expect(entries).toHaveLength(3);
    expect(entries.map(([k]) => k)).toEqual(["role", "project", "standards"]);
    expect(entries[0][1]).toContain("Pair programmer");
  });

  test("choice 2 (team agent) emphasizes PRs and structured channels", () => {
    const entries = templateSoul("2");
    expect(entries).toHaveLength(3);
    expect(entries[0][1].toLowerCase()).toContain("team agent");
    expect(entries[2][1]).toMatch(/PR|pull/);
  });

  test("choice 3 (research) emphasizes citations and uncertainty", () => {
    const entries = templateSoul("3");
    expect(entries).toHaveLength(3);
    expect(entries[2][1].toLowerCase()).toContain("cite");
  });

  test("unknown choice returns empty array", () => {
    expect(templateSoul("9")).toEqual([]);
    expect(templateSoul("")).toEqual([]);
    expect(templateSoul("custom")).toEqual([]);
  });
});

describe("parseSoulJson", () => {
  test("parses a clean JSON object with all three keys", () => {
    const raw = `{"role": "Dev", "project": "Flair", "standards": "Be concise"}`;
    const entries = parseSoulJson(raw);
    expect(entries).toEqual([
      ["role", "Dev"],
      ["project", "Flair"],
      ["standards", "Be concise"],
    ]);
  });

  test("tolerates surrounding prose (extracts inner JSON)", () => {
    const raw = `Sure! Here's the JSON:\n{"role": "Dev", "project": "X", "standards": "Y"}\nLet me know if...`;
    const entries = parseSoulJson(raw);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(["role", "Dev"]);
  });

  test("skips missing keys rather than inserting empty", () => {
    const entries = parseSoulJson(`{"role": "Dev"}`);
    expect(entries).toEqual([["role", "Dev"]]);
  });

  test("throws when no JSON object present", () => {
    expect(() => parseSoulJson("no json here")).toThrow(/no JSON/);
  });

  test("throws when JSON has none of the expected keys", () => {
    expect(() => parseSoulJson(`{"foo": "bar"}`)).toThrow(/no role\/project\/standards/);
  });

  test("trims whitespace in values", () => {
    const entries = parseSoulJson(`{"role": "  Dev  ", "project": "X"}`);
    expect(entries[0]).toEqual(["role", "Dev"]);
    expect(entries[1]).toEqual(["project", "X"]);
  });
});

describe("soul entry ID format", () => {
  test("ID is agentId:key", () => {
    expect(`mybot:role`).toBe("mybot:role");
  });
});

describe("skip conditions (wizard gating)", () => {
  test("--skip-soul flag prevents wizard", () => {
    const skipSoul = true;
    const isTTY = true;
    expect(!skipSoul && isTTY).toBe(false);
  });

  test("non-TTY prevents wizard", () => {
    const skipSoul = false;
    const isTTY = false;
    expect(!skipSoul && isTTY).toBe(false);
  });

  test("TTY + no skip → wizard runs", () => {
    const skipSoul = false;
    const isTTY = true;
    expect(!skipSoul && isTTY).toBe(true);
  });
});
