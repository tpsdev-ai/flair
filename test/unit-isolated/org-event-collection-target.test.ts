import { afterAll, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const requireHere = createRequire(import.meta.url);
const harperRoot = dirname(requireHere.resolve("harper/package.json"));
const { Resource } = requireHere(join(harperRoot, "dist/resources/Resource.js"));
const { RequestTarget } = requireHere(join(harperRoot, "dist/resources/RequestTarget.js"));
let written: any;

class EventTable extends Resource {
  static get(id: any, context?: any) { return context?.transaction?.rows.get(id) ?? written ?? null; }
  static put(content: any, context: any) {
    expect(context.transaction.open).toBe(1);
    context.transaction.rows.set(content.id, { ...content });
    return content;
  }
}

mock.module("harper", () => ({
  Resource,
  databases: { flair: { OrgEvent: EventTable } },
  server: { http: () => {}, getUser: async () => null },
}));

const previousTransaction = (globalThis as any).transaction;
(globalThis as any).transaction = async (context: any, callback: () => Promise<any>) => {
  const previous = context.transaction;
  const rows = new Map();
  context.transaction = { open: 1, rows };
  try {
    const result = await callback();
    for (const row of rows.values()) written = row;
    return result;
  } finally {
    context.transaction = previous;
  }
};
afterAll(() => { (globalThis as any).transaction = previousTransaction; });

const { OrgEvent } = await import("../../resources/OrgEvent.ts");

test("OrgEvent POST without a body id takes the prefixed collection target id", async () => {
  const target = new RequestTarget("/prefix/");
  const content = { kind: "status", summary: "collection target" };
  const resource = await OrgEvent.getResource(target, {
    data: Promise.resolve(content),
    request: { tpsAgent: "collection-author", tpsAgentIsAdmin: false },
  }, { method: "post", isCollection: target.isCollection });
  expect(resource.isCollection).toBe(true);
  expect(resource.getId()).toBe("prefix/");
  const result = await resource.post(content);
  expect(result instanceof Response).toBe(false);
  expect(written.id).toBe("prefix/");
});
