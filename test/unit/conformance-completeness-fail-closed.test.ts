// A skipped/unrunnable connector-conformance COMPLETENESS check must not render
// as a passing one (flair#1213, Sherlock #3 — the flair#953 lesson).
//
// The completeness gate ("a new /mcp tool without a contract fails the build")
// has the exact failure mode docs-freshness had: if it cannot enumerate the
// tool list — the `TOOLS` import failed and left it `undefined`, or the registry
// is empty — a naive gate finds "0 tools, 0 missing" and reports success. Six
// checks, six ticks, one a lie. So `checkContractCompleteness` is FAIL-CLOSED:
// an un-enumerable or empty registry returns ok:false with examined:0, and a
// pass is only ever reported with examined > 0.
//
// These are behaviour tests on that function's contract: they drive it with a
// real registry, an empty one, an unloadable one, and a registry missing a
// contract, and assert the return value a CI step consumes — never inferring
// "it would fail" from the happy path (which returns a perfectly well-formed
// empty `missing` list either way).

import { describe, expect, test } from "bun:test";
import {
  checkContractCompleteness,
  INTERNAL_MEMORY_FIELDS,
  TOOLS,
  type CompletenessResult,
} from "../../resources/mcp-tools.ts";

describe("completeness gate — the real shipped registry", () => {
  const res = checkContractCompleteness(TOOLS);

  test("every shipped tool carries a contract (ok, nothing missing)", () => {
    expect(res.missing, `tools missing a contract: ${res.missing.join(", ")}`).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test("examined equals the shipped tool count and is > 0 (not a vacuous pass)", () => {
    const shipped = Object.keys(TOOLS).length;
    expect(shipped).toBeGreaterThan(0);
    expect(res.examined).toBe(shipped);
  });
});

describe("fail-closed: a check that could not run must not look like a pass", () => {
  // The whole bug in one table: an un-enumerable or empty registry is NOT ok,
  // and its examined count is 0 — visibly distinct from a real pass (ok + a
  // positive examined count). A caller that keys "did it pass?" off `ok` alone,
  // or "how much did it cover?" off `examined`, can tell the two apart.
  const cases: Array<[label: string, input: any]> = [
    ["undefined (import left it unloaded)", undefined],
    ["null", null],
    ["an array (not a plain registry object)", []],
    ["a string (not an object)", "TOOLS"],
    ["an empty registry", {}],
  ];

  for (const [label, input] of cases) {
    test(`${label} → ok:false, examined:0, with a reason`, () => {
      const r: CompletenessResult = checkContractCompleteness(input);
      expect(r.ok, `${label} must NOT report ok`).toBe(false);
      expect(r.examined, `${label} must report examined:0`).toBe(0);
      expect(typeof r.reason, `${label} must name why it did not pass`).toBe("string");
    });
  }

  test("no input yields a pass with examined:0 (a pass always covered something)", () => {
    for (const [, input] of cases) {
      const r = checkContractCompleteness(input);
      expect(r.ok && r.examined === 0, "a vacuous ok+examined:0 is impossible").toBe(false);
    }
  });
});

describe("fail-closed: a tool shipped without a contract fails and is named", () => {
  test("a registry with one contract-less tool fails, names the tool, still examines it", () => {
    const r = checkContractCompleteness({
      good: { def: {}, impl: () => {}, contract: { summary: "ok" } } as any,
      naked: { def: {}, impl: () => {} } as any,
    });
    expect(r.ok).toBe(false);
    expect(r.examined).toBe(2);
    expect(r.missing).toContain("naked");
    expect(r.missing).not.toContain("good");
    expect(r.reason).toContain("naked");
  });

  test("a contract that is not an object counts as missing", () => {
    const r = checkContractCompleteness({ bad: { def: {}, impl: () => {}, contract: "nope" } as any });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("bad");
  });

  test("a healthy single-tool registry passes with examined:1", () => {
    const r = checkContractCompleteness({ only: { def: {}, impl: () => {}, contract: { summary: "x" } } as any });
    expect(r.ok).toBe(true);
    expect(r.examined).toBe(1);
    expect(r.missing).toEqual([]);
  });
});

describe("the no-leaked-internal-fields enumeration (flair#1213 refinement #1)", () => {
  // The invariant can only bite on a field it enumerates. Sherlock #1: the read
  // path used to strip only `embedding` while `embeddingModel` still leaked, and
  // a contract that checked only `embedding` would pass anyway. Pin BOTH.
  test("INTERNAL_MEMORY_FIELDS enumerates BOTH embedding and embeddingModel", () => {
    expect(INTERNAL_MEMORY_FIELDS).toContain("embedding");
    expect(INTERNAL_MEMORY_FIELDS).toContain("embeddingModel");
  });

  test("every memory-record tool's forbiddenFields enumerates both", () => {
    for (const name of ["memory_get", "memory_store", "memory_update"]) {
      const forbidden = (TOOLS as any)[name].contract.forbiddenFields ?? [];
      expect(forbidden, `${name} must forbid embedding`).toContain("embedding");
      expect(forbidden, `${name} must forbid embeddingModel`).toContain("embeddingModel");
    }
    // memory_search enforces it per-result-element (containerRules).
    const searchRule = (TOOLS as any).memory_search.contract.invariants.containerRules
      .find((r: any) => r.container === "results");
    expect(searchRule.forbiddenFields).toContain("embedding");
    expect(searchRule.forbiddenFields).toContain("embeddingModel");
  });
});
