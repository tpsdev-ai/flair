import { describe, expect, it } from "bun:test";
import { isReservedEventRecord, reservedEventProposedRefusal } from "../../resources/org-event-reserved.js";
import { isReservedEventRecord as contractPredicate } from "../../src/lib/instruction-event-contract.js";
import { findInstructionEventImpostors } from "../../src/lib/instruction-event-doctor.js";

const samples = [
  { event: { id: "kind-only-soul", kind: "soul.changed" }, reserved: true },
  { event: { id: "kind-only-skill", kind: "skill.changed" }, reserved: true },
  { event: { id: "instruction-change:prefix-only", kind: "status" }, reserved: true },
  { event: { id: "instruction-change:both", kind: "soul.changed" }, reserved: true },
  { event: { id: "ordinary", kind: "status" }, reserved: false },
  { event: { id: "near-prefix", kind: "soul.changed.extra" }, reserved: false },
  { event: { id: "instruction-change", kind: "status" }, reserved: false },
  { event: { id: 42, kind: false }, reserved: false },
  { event: {}, reserved: false },
];

describe("reserved marker classification", () => {
  it("resource classifies kind-only and prefix-only records as reserved", () => {
    for (const { event, reserved } of samples) {
      expect(reservedEventProposedRefusal(event)?.status === 403, JSON.stringify(event)).toBe(reserved);
    }
  });

  it("doctor reports kind-only and prefix-only impostors", () => {
    for (const { event, reserved } of samples) {
      expect(findInstructionEventImpostors([event], []).length > 0, JSON.stringify(event)).toBe(reserved);
    }
  });

  it("doctor and resource classify the same samples identically", () => {
    expect(isReservedEventRecord).toBe(contractPredicate);
    for (const { event } of samples) {
      expect(findInstructionEventImpostors([event], []).length > 0, JSON.stringify(event))
        .toBe(reservedEventProposedRefusal(event) !== null);
    }
  });
});
