import { describe, expect, it } from "bun:test";
import { isReservedEventRecord, reservedEventProposedRefusal } from "../../resources/org-event-reserved.js";
import { isReservedEventRecord as contractPredicate } from "../../src/lib/instruction-event-contract.js";
import { describeInstructionEventImpostors, findInstructionEventImpostors, instructionEventSatisfiesReaderRule } from "../../src/lib/instruction-event-doctor.js";

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

describe("instruction-event reader failures", () => {
  const version = { id: "version", subjectType: "soul" };
  const valid = { id: "instruction-change:version", kind: "soul.changed", refId: "version" };
  const cases = [
    { event: { ...valid, id: "kind-only" }, reason: "missing prefix" },
    { event: { ...valid, kind: "status" }, reason: "kind mismatch" },
    { event: { ...valid, kind: "skill.changed" }, reason: "kind mismatch" },
    { event: { ...valid, refId: "absent" }, reason: "no matching version" },
    { event: { ...valid, id: "instruction-change:other" }, reason: "suffix mismatch" },
  ];
  for (const { event, reason } of cases) {
    it(`reports ${reason} for ${JSON.stringify(event)}`, () => {
      expect(instructionEventSatisfiesReaderRule(event, event.refId === version.id ? version : undefined)).toBe(false);
      expect(describeInstructionEventImpostors([event], [version])).toBe(
        `1 stored OrgEvent row carries a reserved kind or id but fails the instruction-event reader rule: ${event.id} (${reason})`,
      );
    });
  }
  it("passes an event satisfying the reader rule", () => {
    expect(instructionEventSatisfiesReaderRule(valid, version)).toBe(true);
    expect(describeInstructionEventImpostors([valid], [version])).toBeNull();
  });
});
