import { describe, expect, test, beforeAll } from "bun:test";
import "../helpers/mock-tables";

describe("memory durability guards", () => {
  let MemoryResource: any;

  beforeAll(async () => {
    globalThis.mockMemories = new Map();
    const mod = await import("../../resources/Memory");
    MemoryResource = new mod.Memory();
  });

  test("permanent memory rejects delete", async () => {
    const id = "p1";
    globalThis.mockMemories.set(id, { id, content: "stay", durability: "permanent" });
    
    const res = await MemoryResource.delete(id);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("permanent_memory_cannot_be_deleted");
    
    expect(globalThis.mockMemories.has(id)).toBe(true);
  });

  test("standard memory allows delete", async () => {
    const id = "s1";
    globalThis.mockMemories.set(id, { id, content: "go", durability: "standard" });
    
    await MemoryResource.delete(id);
    expect(globalThis.mockMemories.has(id)).toBe(false);
  });
});
