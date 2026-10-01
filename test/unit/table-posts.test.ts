// resources/table-posts.ts guards every table class in the flair database's
// table registry when it loads, with the caller resolved from the resource's
// context (resources/agent-auth.ts's resolveAgentAuth), here against a mocked
// registry. The policy itself is covered by test/unit/table-post-policy.test.ts.
// The non-admin refusal through the installed guard is unit-tested here; live
// integration (test/integration/collection-post-attribution.test.ts) covers the
// administrator path through the guard, an administrator's POST to Peer.
import { describe, expect, test, mock } from "bun:test";
import { TABLE_POST_GUARD } from "../../resources/table-post-policy";

const posted: string[] = [];

class Base {
  context: unknown;
  constructor(context?: unknown) { this.context = context; }
  getContext() { return this.context; }
  async post(content: any) { posted.push(content.id); return content; }
}
class Relationship extends Base {}
class Instance extends Base {}
class Peer extends Base {}

const databasesMock = { flair: { Relationship, Instance, Peer } as Record<string, typeof Base> };

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: databasesMock, Resource: class {} }));

const loadErrors: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => { loadErrors.push(args.map(String).join(" ")); };
try {
  await import("../../resources/table-posts.ts");
} finally {
  console.error = consoleError;
}
const { internalContext } = await import("../../resources/in-process.ts");

const asAgent = (agentId: string, isAdmin: boolean) => ({ request: { tpsAgent: agentId, tpsAgentIsAdmin: isAdmin } });

describe("table-posts: every table in the registry is guarded at load", () => {
  test("a complete installation logs no gap", () => {
    expect(loadErrors.filter((line) => line.includes("collection POST guard"))).toEqual([]);
  });

  test("each table class in databases.flair has its own guarded post()", () => {
    for (const [name, table] of Object.entries(databasesMock.flair)) {
      expect(Object.prototype.hasOwnProperty.call(table, TABLE_POST_GUARD), name).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(table.prototype, "post"), name).toBe(true);
    }
  });

  test("a collection POST is refused for a non-admin agent (403) and a caller without a credential (401)", async () => {
    posted.length = 0;
    for (const table of Object.values(databasesMock.flair)) {
      await expect(new table(asAgent("a", false)).post({ id: "agent" })).rejects.toMatchObject({ statusCode: 403 });
      await expect(new table({ request: { tpsAnonymous: true } }).post({ id: "anonymous" })).rejects.toMatchObject({ statusCode: 401 });
    }
    expect(posted).toEqual([]);
  });

  test("an administrator and an in-process call reach the table's post()", async () => {
    posted.length = 0;
    await new Instance(asAgent("root", true)).post({ id: "admin" });
    await new Instance(internalContext()).post({ id: "internal" });
    expect(posted).toEqual(["admin", "internal"]);
  });

  test("a resource class that defines post() keeps it", async () => {
    posted.length = 0;
    class RelationshipResource extends Relationship {
      async post(content: any) { content.id = `${content.id}-prepared`; return super.post(content); }
    }
    await new RelationshipResource(asAgent("a", false)).post({ id: "own" });
    expect(posted).toEqual(["own-prepared"]);
  });
});
