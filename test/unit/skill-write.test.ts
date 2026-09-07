import { describe, expect, test } from "bun:test";
import {
  SKILL_TAG,
  isSkillWrite,
  skillEmbedText,
  enforceSkillDurability,
  skillScanGate,
} from "../../resources/skill-write.ts";

describe("isSkillWrite", () => {
  test("true when tags includes the skill tag", () => {
    expect(isSkillWrite({ tags: ["skill"] })).toBe(true);
    expect(isSkillWrite({ tags: ["skill", "cli"] })).toBe(true);
  });
  test("false for non-skill rows (no tags, other tags, non-array)", () => {
    expect(isSkillWrite({ tags: ["lesson"] })).toBe(false);
    expect(isSkillWrite({ tags: [] })).toBe(false);
    expect(isSkillWrite({})).toBe(false);
    expect(isSkillWrite({ tags: "skill" })).toBe(false);
    expect(isSkillWrite(null)).toBe(false);
  });
});

describe("skillEmbedText", () => {
  test("skill rows embed from trigger", () => {
    expect(skillEmbedText({ tags: ["skill"], trigger: "when to use", content: "procedure" })).toBe("when to use");
  });
  test("skill rows with empty trigger fall back to content", () => {
    expect(skillEmbedText({ tags: ["skill"], trigger: "", content: "procedure" })).toBe("procedure");
    expect(skillEmbedText({ tags: ["skill"], content: "procedure" })).toBe("procedure");
  });
  test("non-skill rows embed from content (byte-identical to pre-slice)", () => {
    expect(skillEmbedText({ content: "hello" })).toBe("hello");
    expect(skillEmbedText({ tags: ["lesson"], content: "hello" })).toBe("hello");
  });
  test("returns undefined when there is no usable text", () => {
    expect(skillEmbedText({})).toBeUndefined();
    expect(skillEmbedText({ tags: ["skill"] })).toBeUndefined();
  });
});

describe("enforceSkillDurability", () => {
  test("non-skill rows are untouched (null, durability unchanged)", () => {
    const content = { durability: "standard" };
    expect(enforceSkillDurability(content)).toBeNull();
    expect(content.durability).toBe("standard");
  });
  test("skill rows are forced to persistent", () => {
    const content = { tags: ["skill"], durability: "standard" };
    expect(enforceSkillDurability(content)).toBeNull();
    expect(content.durability).toBe("persistent");
  });
  test("skill rows with no durability are forced to persistent", () => {
    const content: Record<string, any> = { tags: ["skill"] };
    expect(enforceSkillDurability(content)).toBeNull();
    expect(content.durability).toBe("persistent");
  });
  test("skill rows with permanent are forced to persistent", () => {
    const content = { tags: ["skill"], durability: "permanent" };
    expect(enforceSkillDurability(content)).toBeNull();
    expect(content.durability).toBe("persistent");
  });
  test("skill rows with ephemeral/session are rejected (400 skill_durability)", async () => {
    for (const d of ["ephemeral", "session"]) {
      const content = { tags: ["skill"], durability: d };
      const res = enforceSkillDurability(content);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toBe("skill_durability");
    }
  });
});

describe("skillScanGate", () => {
  test("non-skill rows are a no-op (null)", () => {
    expect(skillScanGate({ content: "exec(rm -rf /)" })).toBeNull();
  });
  test("a clean skill passes (null)", () => {
    expect(skillScanGate({ tags: ["skill"], trigger: "when to use", content: "a safe procedure" })).toBeNull();
  });
  test("a skill with a shell_command payload is rejected (400 skill_scan_rejected)", async () => {
    const res = skillScanGate({ tags: ["skill"], trigger: "run this", content: "```bash\nexec(rm -rf /)\n```" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("skill_scan_rejected");
  });
  test("a skill with a critical shell+base64 payload is rejected", async () => {
    const res = skillScanGate({ tags: ["skill"], trigger: "run this", content: "```bash\nexec(atob('cm0gLXJmIC8='))\n```" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("skill_scan_rejected");
    expect(body.riskLevel).toBe("critical");
  });
  test("a dangerous payload in trigger (not content) is also rejected", async () => {
    const res = skillScanGate({ tags: ["skill"], trigger: "exec(rm -rf /)", content: "safe" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("skill_scan_rejected");
  });
  test("a medium-risk skill is allow-with-flag (null, _safetyFlags appended)", () => {
    const content: Record<string, any> = { tags: ["skill"], trigger: "see https://example.com for docs", content: "a safe procedure" };
    const res = skillScanGate(content);
    expect(res).toBeNull();
    expect(Array.isArray(content._safetyFlags)).toBe(true);
    expect(content._safetyFlags.some((f: string) => f.startsWith("skill:"))).toBe(true);
  });
  test("allow-with-flag appends to existing _safetyFlags (no overwrite)", () => {
    const content = { tags: ["skill"], trigger: "see https://example.com", content: "safe", _safetyFlags: ["existing"] };
    skillScanGate(content);
    expect(content._safetyFlags).toContain("existing");
    expect(content._safetyFlags.some((f: string) => f.startsWith("skill:"))).toBe(true);
  });
});
