import { describe, expect, it } from "bun:test";
import { migrationCycleDone } from "../helpers/migration-cycle-done.ts";

describe("migrationCycleDone", () => {
  it("accepts done with no cycle error", () => {
    expect(migrationCycleDone({ cyclePhase: "done", lastCycleError: null })).toBe(true);
  });

  it("rejects done with the cycle error", () => {
    const error = "unexpected cycle error: state read failed";
    expect(() => migrationCycleDone({ cyclePhase: "done", lastCycleError: error })).toThrow(error);
    expect(() => migrationCycleDone({ cyclePhase: "done", lastCycleError: "" })).toThrow();
  });

  it("keeps waiting for non-terminal phases", () => {
    for (const cyclePhase of ["idle", "scheduled", "pre-hash", "running"]) {
      expect(migrationCycleDone({ cyclePhase, lastCycleError: null })).toBe(false);
      expect(migrationCycleDone({ cyclePhase, lastCycleError: "previous error" })).toBe(false);
    }
    expect(migrationCycleDone(null)).toBe(false);
    expect(migrationCycleDone(undefined)).toBe(false);
  });
});
