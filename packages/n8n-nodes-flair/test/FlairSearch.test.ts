import { describe, test, expect } from "bun:test";
import { FlairSearch } from "../src/nodes/FlairSearch/FlairSearch.node";

describe("FlairSearch node description", () => {
  const node = new FlairSearch();

  test("identifies as flairSearch on the AI Tool socket", () => {
    expect(node.description.name).toBe("flairSearch");
    expect(node.description.displayName).toBe("Flair Search");
    expect(node.description.outputs).toEqual(["ai_tool" as any] as any);
  });

  test("declares operation property with two operations", () => {
    const op = node.description.properties.find((p) => p.name === "operation")!;
    expect(op).toBeDefined();
    const values = ((op as any).options ?? []).map((o: any) => o.value);
    expect(values).toContain("search");
    expect(values).toContain("getBySubject");
  });

  test("query is required when operation = search", () => {
    const q = node.description.properties.find((p) => p.name === "query")!;
    expect(q.required).toBe(true);
    expect((q as any).displayOptions?.show?.operation).toEqual(["search"]);
  });

  test("subject is required when operation = getBySubject", () => {
    const s = node.description.properties.find((p) => p.name === "subject")!;
    expect(s.required).toBe(true);
    expect((s as any).displayOptions?.show?.operation).toEqual(["getBySubject"]);
  });

  test("limit defaults to 5", () => {
    const l = node.description.properties.find((p) => p.name === "limit")!;
    expect(l.default).toBe(5);
  });

  test("includes notice about Get By Tag deferred to spec §6 carry-forward", () => {
    const notice = node.description.properties.find((p) => p.name === "tagNotice");
    expect(notice).toBeDefined();
    expect((notice as any).type).toBe("notice");
    expect((notice as any).displayName).toContain("Get By Tag");
  });

  test("requires the flairApi credential", () => {
    const cred = node.description.credentials!.find((c) => c.name === "flairApi")!;
    expect(cred.required).toBe(true);
  });

  test("declares an n8n AI Tool output", () => {
    expect(node.description.outputs).toContain("ai_tool" as any);
  });
});
