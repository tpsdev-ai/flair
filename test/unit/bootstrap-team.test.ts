// Unit tests for the MemoryBootstrap "## Team" roster helpers (PR #549 review
// findings: injection hardening on teammate ids + pre-1.0 compat coverage).
//
// These exercise the real shipped logic via the Harper-free lib — importing
// MemoryBootstrap.ts directly pulls in the Harper runtime (`databases` /
// `Resource`, storage init) and can't run outside a live Harper.

import { describe, test, expect } from "bun:test";
import { isTeammate, formatTeamLine } from "../../resources/memory-bootstrap-lib.ts";

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

describe("formatTeamLine", () => {
  test("empty roster produces no line", () => {
    expect(formatTeamLine([])).toBeNull();
  });

  test("singular phrasing for exactly one teammate", () => {
    const line = formatTeamLine(["anvil"]);
    expect(line).toContain("1 other agent shares this Flair office");
    expect(line).not.toContain("agents share");
  });

  test("plural phrasing for more than one teammate", () => {
    const line = formatTeamLine(["anvil", "kern", "sherlock"]);
    expect(line).toContain("3 other agents share this Flair office");
  });

  test("teammate ids pass through wrapUntrusted in the output", () => {
    const line = formatTeamLine(["anvil"]);
    expect(line).not.toBeNull();
    expect(line).toContain("[⚠️ SAFETY:");
    expect(line).toContain("[/SAFETY]");
    expect(line).toContain("anvil");
  });

  test("the trusted instructional text is NOT inside the safety wrapper", () => {
    const line = formatTeamLine(["anvil"]);
    expect(line).not.toBeNull();
    // The nudge sentence should appear after the closing [/SAFETY] marker,
    // i.e. outside the untrusted block — only the id list is wrapped.
    const safetyEnd = line!.indexOf("[/SAFETY]");
    const nudgeStart = line!.indexOf("Before deep-diving an unfamiliar problem");
    expect(safetyEnd).toBeGreaterThan(-1);
    expect(nudgeStart).toBeGreaterThan(safetyEnd);
  });
});
