// flair#2139 S2 completion — the TEST-ONLY skill-write fault hook is gated so it
// can never fire in production (resources/skill-write-fault.ts). TWO exact-match
// conditions are required: the arming env var equals "1" AND the write's owner id
// is the reserved prefix plus the step name. Production sets neither.
import { describe, expect, test } from "bun:test";
import {
  ENABLE_TEST_FAULTS_ENV,
  TEST_FAULT_AGENT_PREFIX,
  faultStepOfAgent,
  maybeThrowSkillWriteFault,
  skillWriteFaultArmed,
} from "../../resources/skill-write-fault.ts";

const faultAgent = (step: string) => `${TEST_FAULT_AGENT_PREFIX}${step}`;
const ARMED = { [ENABLE_TEST_FAULTS_ENV]: "1" };

describe("skillWriteFaultArmed — two exact-match gates (flair#2139 S2)", () => {
  test("unset env var: never armed, whatever the agent id", () => {
    expect(skillWriteFaultArmed("successor", faultAgent("successor"), {})).toBe(false);
  });

  test("the arming var plus the step in the agent id: armed", () => {
    expect(skillWriteFaultArmed("append", faultAgent("append"), ARMED)).toBe(true);
  });

  test("a different step than the one encoded in the agent id: not armed", () => {
    expect(skillWriteFaultArmed("close", faultAgent("successor"), ARMED)).toBe(false);
  });

  test("the arming var but an ordinary agent id: not armed (production shape)", () => {
    expect(skillWriteFaultArmed("successor", "real-agent", ARMED)).toBe(false);
    expect(skillWriteFaultArmed("successor", undefined, ARMED)).toBe(false);
  });

  test("a value like 'true' does not arm the hook", () => {
    expect(skillWriteFaultArmed("successor", faultAgent("successor"), { [ENABLE_TEST_FAULTS_ENV]: "true" })).toBe(false);
  });

  test("a reserved prefix with an unknown step name arms nothing", () => {
    expect(faultStepOfAgent(`${TEST_FAULT_AGENT_PREFIX}whatever`)).toBeNull();
    expect(skillWriteFaultArmed("successor", `${TEST_FAULT_AGENT_PREFIX}whatever`, ARMED)).toBe(false);
  });
});

describe("maybeThrowSkillWriteFault", () => {
  test("throws when armed", () => {
    expect(() => maybeThrowSkillWriteFault("pointer", faultAgent("pointer"), ARMED)).toThrow(/pointer/);
  });

  test("is a no-op otherwise", () => {
    expect(() => maybeThrowSkillWriteFault("pointer", faultAgent("pointer"), {})).not.toThrow();
    expect(() => maybeThrowSkillWriteFault("pointer", "real-agent", ARMED)).not.toThrow();
  });
});
