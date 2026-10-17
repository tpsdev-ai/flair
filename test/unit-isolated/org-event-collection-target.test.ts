import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const requireHere = createRequire(import.meta.url);
const harperRoot = dirname(requireHere.resolve("harper/package.json"));
const { Resource } = requireHere(join(harperRoot, "dist/resources/Resource.js"));
const { RequestTarget } = requireHere(join(harperRoot, "dist/resources/RequestTarget.js"));
let written: any;

class EventTable extends Resource {
  static get() { return null; }
  static put(content: any) { written = { ...content }; return content; }
}

mock.module("harper", () => ({
  Resource,
  databases: { flair: { OrgEvent: EventTable } },
  server: { http: () => {}, getUser: async () => null },
}));

const { OrgEvent } = await import("../../resources/OrgEvent.ts");

test("OrgEvent POST without a body id takes the prefixed collection target id", async () => {
  const target = new RequestTarget("/prefix/");
  const resource = await OrgEvent.getResource(target, {
    request: { tpsAgent: "collection-author", tpsAgentIsAdmin: false },
  }, { method: "post", isCollection: target.isCollection });
  expect(resource.isCollection).toBe(true);
  expect(resource.getId()).toBe("prefix/");
  await resource.post({ kind: "status", summary: "collection target" });
  expect(written.id).toBe("prefix/");
});
