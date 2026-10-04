// Unit tests for the MemoryBootstrap roster helpers (PR #549 review findings:
// pre-1.0 compat coverage) and the flair#2141 S3a fixed directory hint that
// replaced the unbounded "## Team" roster line.
//
// These exercise the real shipped logic via the Harper-free lib — importing
// MemoryBootstrap.ts directly pulls in the Harper runtime (`databases` /
// `Resource`, storage init) and can't run outside a live Harper.

import { describe, test, expect } from "bun:test";
import { isTeammate, DIRECTORY_HINT_TEXT, directoryHint } from "../../resources/memory-bootstrap-lib.ts";

describe("isTeammate", () => {
  test("excludes the caller's own record", () => {
    expect(isTeammate({ id: "flint", kind: "agent", status: "active" }, "flint")).toBe(false);
  });

  test("excludes kind=human", () => {
    expect(isTeammate({ id: "nathan", kind: "human", status: "active" }, "flint")).toBe(false);
  });

  test("excludes status=deactivated", () => {
    expect(isTeammate({ id: "old-agent", kind: "agent", status: "deactivated" }, "flint")).toBe(false);
  });

  test("includes a record with NO kind/status fields (pre-1.0 compat)", () => {
    // Agent.ts only defaults kind/status on registration from the 1.0 auth
    // reshape onward (`kind ||= "agent"`, `status ||= "active"`). Records
    // written before that have neither field — this is the semantics that
    // matters most: absence must mean "legacy agent, active", not "exclude".
    expect(isTeammate({ id: "anvil" }, "flint")).toBe(true);
  });

  test("includes a normal active agent record", () => {
    expect(isTeammate({ id: "kern", kind: "agent", status: "active" }, "flint")).toBe(true);
  });
});

describe("directoryHint", () => {
  test("is a fixed, non-empty string", () => {
    expect(typeof directoryHint()).toBe("string");
    expect(directoryHint().length).toBeGreaterThan(0);
  });

  test("is constant — the same bytes on every call (no per-agent data)", () => {
    expect(directoryHint()).toBe(directoryHint());
    expect(directoryHint()).toBe(DIRECTORY_HINT_TEXT);
  });

  test("names the discovery surface, not an inline roster", () => {
    expect(directoryHint()).toContain("team_directory");
    expect(directoryHint()).toContain("GET /TeamDirectory");
    expect(directoryHint()).toContain("active agents with published tps-mail addresses");
  });
});
