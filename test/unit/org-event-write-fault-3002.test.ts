// flair#3002 — the OrgEvent writer fault hook is an injection point that is
// empty unless the test-only fixture installs it
// (resources/org-event-write-fault.ts,
// test/fixtures/org-event-write-fault-3002/probe.js).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { maybeFaultOrgEventRow, setOrgEventWriteFaultHook } from "../../resources/org-event-write-fault.ts";

const ROOT = join(import.meta.dir, "..", "..");

afterEach(() => setOrgEventWriteFaultHook(null));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

describe("OrgEvent writer fault hook (flair#3002)", () => {
  test("no installed hook leaves the row untouched", () => {
    for (const site of ["a2a", "agent-key-register", "graph-heal"] as const) {
      const row = { id: "e1", summary: "kept" };
      expect(() => maybeFaultOrgEventRow(site, row)).not.toThrow();
      expect(row).toEqual({ id: "e1", summary: "kept" });
    }
  });

  test("an installed hook runs for its site; clearing it restores the no-op", () => {
    setOrgEventWriteFaultHook((site, row) => {
      if (site === "a2a") row.summary = 123;
    });
    const row: Record<string, any> = { summary: "kept" };
    maybeFaultOrgEventRow("a2a", row);
    expect(row.summary).toBe(123);
    const other: Record<string, any> = { summary: "kept" };
    maybeFaultOrgEventRow("agent-key-register", other);
    expect(other.summary).toBe("kept");
    setOrgEventWriteFaultHook(null);
    const after: Record<string, any> = { summary: "kept" };
    maybeFaultOrgEventRow("a2a", after);
    expect(after.summary).toBe("kept");
  });

  test("nothing under resources/ or src/ installs the hook", () => {
    const callers = [...sources(join(ROOT, "resources")), ...sources(join(ROOT, "src"))]
      .filter((p) => readFileSync(p, "utf8").includes("setOrgEventWriteFaultHook"))
      .map((p) => relative(ROOT, p));
    expect(callers).toEqual([join("resources", "org-event-write-fault.ts")]);
  });

  test("the fixture that installs it is outside the package's files", () => {
    const files: string[] = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files;
    expect(files.some((f) => f.replace(/\/$/, "") === "test" || f.startsWith("test/"))).toBe(false);
    expect(readFileSync(join(ROOT, "test", "fixtures", "org-event-write-fault-3002", "probe.js"), "utf8"))
      .toContain("setOrgEventWriteFaultHook(");
  });
});
