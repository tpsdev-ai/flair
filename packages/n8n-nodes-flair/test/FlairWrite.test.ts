import { describe, test, expect } from "bun:test";
import { FlairWrite } from "../src/nodes/FlairWrite/FlairWrite.node";

describe("FlairWrite node description", () => {
  const node = new FlairWrite();

  test("identifies as flairWrite on the Main socket", () => {
    expect(node.description.name).toBe("flairWrite");
    expect(node.description.displayName).toBe("Flair Write");
    expect(node.description.inputs).toEqual(["main" as any] as any);
    expect(node.description.outputs).toEqual(["main" as any] as any);
  });

  test("requires the flairApi credential", () => {
    const cred = node.description.credentials!.find((c) => c.name === "flairApi")!;
    expect(cred.required).toBe(true);
  });

  test("declares required content property defaulting to $json.content", () => {
    const c = node.description.properties.find((p) => p.name === "content")!;
    expect(c.required).toBe(true);
    expect(c.default).toBe("={{ $json.content }}");
  });

  test("declares optional subject + tags", () => {
    const subject = node.description.properties.find((p) => p.name === "subject")!;
    expect(subject).toBeDefined();
    expect(subject.required).toBeUndefined();

    const tags = node.description.properties.find((p) => p.name === "tags")!;
    expect(tags).toBeDefined();
    expect(tags.default).toBe("");
  });

  test("declares durability with the four Flair tiers", () => {
    const dur = node.description.properties.find((p) => p.name === "durability")!;
    expect(dur).toBeDefined();
    const values = ((dur as any).options ?? []).map((o: any) => o.value);
    expect(values).toEqual(["standard", "persistent", "permanent", "ephemeral"]);
    expect(dur.default).toBe("standard");
  });

  test("declares type with the six Flair memory types", () => {
    const type = node.description.properties.find((p) => p.name === "type")!;
    expect(type).toBeDefined();
    const values = ((type as any).options ?? []).map((o: any) => o.value);
    expect(values).toEqual(["session", "lesson", "decision", "preference", "fact", "goal"]);
    expect(type.default).toBe("session");
  });

  test("declares skipEmpty boolean default true", () => {
    const skip = node.description.properties.find((p) => p.name === "skipEmpty")!;
    expect(skip).toBeDefined();
    expect((skip as any).type).toBe("boolean");
    expect(skip.default).toBe(true);
  });

  test("registers as an Output (group: output)", () => {
    expect(node.description.group).toEqual(["output"]);
  });

  test("codex categorizes under AI / Memory", () => {
    const codex = node.description.codex!;
    expect(codex.categories).toContain("AI");
    expect((codex.subcategories as any).AI).toContain("Memory");
  });
});
