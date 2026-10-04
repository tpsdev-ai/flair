import { describe, expect, test } from "bun:test";
import { carrySkillSubjectId, deriveSkillSubjectId } from "../../resources/skill-subject.ts";

describe("deriveSkillSubjectId", () => {
  test("a brand-new skill derives its subject from the first physical Memory id", () => {
    expect(deriveSkillSubjectId({ newPhysicalId: "mem-1" })).toBe("mem-1");
  });

  test("first enrollment of an existing skill uses the stored row's id", () => {
    expect(deriveSkillSubjectId({ newPhysicalId: "mem-2", storedHead: { id: "mem-1" } })).toBe("mem-1");
  });

  test("a stored skillSubjectId is carried across a successor", () => {
    expect(deriveSkillSubjectId({ newPhysicalId: "mem-3", storedHead: { id: "mem-2", skillSubjectId: "subject-1" } })).toBe("subject-1");
  });

  test("an explicit successor inherits its predecessor's established subject", () => {
    expect(deriveSkillSubjectId({ newPhysicalId: "mem-3", predecessor: { id: "mem-2", skillSubjectId: "subject-1" } })).toBe("subject-1");
  });

  test("an explicit successor enrolls an unenrolled predecessor's physical id", () => {
    expect(deriveSkillSubjectId({ newPhysicalId: "mem-3", predecessor: { id: "mem-2" } })).toBe("mem-2");
  });

  test("an explicit predecessor's established subject wins over the stored head's", () => {
    expect(deriveSkillSubjectId({
      newPhysicalId: "mem-4",
      storedHead: { id: "mem-3", skillSubjectId: "subject-stored" },
      predecessor: { id: "mem-2", skillSubjectId: "subject-pred" },
    })).toBe("subject-pred");
  });

  test("never derives from a fresh successor id when an established subject exists", () => {
    const subject = deriveSkillSubjectId({ newPhysicalId: "mem-fresh", predecessor: { id: "mem-old", skillSubjectId: "established" } });
    expect(subject).toBe("established");
    expect(subject).not.toBe("mem-fresh");
  });

  test("a body-supplied skillSubjectId is never read (it is not an input)", () => {
    // The only inputs are physical ids; a stray submitted field has no path in.
    const withStray = { newPhysicalId: "mem-1", skillSubjectId: "forged" } as unknown as Parameters<typeof deriveSkillSubjectId>[0];
    expect(deriveSkillSubjectId(withStray)).toBe("mem-1");
  });

  test("empty or non-string ids do not become subjects", () => {
    expect(deriveSkillSubjectId({ newPhysicalId: "mem-9", storedHead: { id: "" }, predecessor: { id: null } })).toBe("mem-9");
  });
});

describe("carrySkillSubjectId", () => {
  test("prefers the predecessor's established subject", () => {
    expect(carrySkillSubjectId({ id: "mem-2", skillSubjectId: "subject-1" }, "mem-3")).toBe("subject-1");
  });
  test("falls back to the predecessor's id", () => {
    expect(carrySkillSubjectId({ id: "mem-2" }, "mem-3")).toBe("mem-2");
  });
  test("falls back to the successor's own id when there is no predecessor", () => {
    expect(carrySkillSubjectId(null, "mem-3")).toBe("mem-3");
  });
});
