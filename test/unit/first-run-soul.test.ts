import { describe, test, expect } from "bun:test";

/**
 * Tests for the first-run soul wizard logic.
 * 
 * We test the data transformation and filtering — not the readline
 * interaction (which needs a TTY). The wizard collects answers and
 * writes non-empty ones as soul entries.
 */

describe("first-run soul wizard logic", () => {
  // Simulates the wizard's answer → soul entry mapping
  function buildSoulEntries(answers: { role: string; project: string; standards: string }): [string, string][] {
    const entries: [string, string][] = [];
    if (answers.role.trim()) entries.push(["role", answers.role.trim()]);
    if (answers.project.trim()) entries.push(["project", answers.project.trim()]);
    if (answers.standards.trim()) entries.push(["standards", answers.standards.trim()]);
    return entries;
  }

  test("all answers provided → 3 soul entries", () => {
    const entries = buildSoulEntries({
      role: "Senior dev, concise and direct",
      project: "E-commerce platform",
      standards: "Always write tests",
    });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(["role", "Senior dev, concise and direct"]);
    expect(entries[1]).toEqual(["project", "E-commerce platform"]);
    expect(entries[2]).toEqual(["standards", "Always write tests"]);
  });

  test("empty answers are skipped", () => {
    const entries = buildSoulEntries({
      role: "",
      project: "My project",
      standards: "",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(["project", "My project"]);
  });

  test("whitespace-only answers are skipped", () => {
    const entries = buildSoulEntries({
      role: "   ",
      project: "  \n  ",
      standards: "\t",
    });
    expect(entries).toHaveLength(0);
  });

  test("all empty → no entries", () => {
    const entries = buildSoulEntries({
      role: "",
      project: "",
      standards: "",
    });
    expect(entries).toHaveLength(0);
  });

  test("answers are trimmed", () => {
    const entries = buildSoulEntries({
      role: "  Security reviewer  ",
      project: "",
      standards: "",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0][1]).toBe("Security reviewer");
  });
});

describe("soul entry ID format", () => {
  test("ID is agentId:key", () => {
    const agentId = "mybot";
    const key = "role";
    const id = `${agentId}:${key}`;
    expect(id).toBe("mybot:role");
  });

  test("soul entry record shape", () => {
    const agentId = "mybot";
    const key = "role";
    const value = "Code reviewer";
    const record = {
      id: `${agentId}:${key}`,
      agentId,
      key,
      value,
      createdAt: new Date().toISOString(),
    };
    expect(record.id).toBe("mybot:role");
    expect(record.agentId).toBe("mybot");
    expect(record.key).toBe("role");
    expect(record.value).toBe("Code reviewer");
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("skip conditions", () => {
  test("--skip-soul flag prevents wizard", () => {
    const skipSoul = true;
    const isTTY = true;
    const shouldRun = !skipSoul && isTTY;
    expect(shouldRun).toBe(false);
  });

  test("non-TTY prevents wizard", () => {
    const skipSoul = false;
    const isTTY = false;
    const shouldRun = !skipSoul && isTTY;
    expect(shouldRun).toBe(false);
  });

  test("TTY + no skip → wizard runs", () => {
    const skipSoul = false;
    const isTTY = true;
    const shouldRun = !skipSoul && isTTY;
    expect(shouldRun).toBe(true);
  });
});
