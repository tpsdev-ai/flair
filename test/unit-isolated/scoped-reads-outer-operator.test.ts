/**
 * Integration, MemoryUsage and MemoryGrant read their own records through the
 * shared scoped search and by-id gate (resources/record-type-kit.ts), so the
 * read scope is always the OUTERMOST AND of a collection query: a
 * caller-supplied top-level operator cannot widen it. The table mock below
 * evaluates the query's OUTER operator, as Harper does.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

const stores: Record<string, Map<string, any>> = {};

function matches(record: any, cond: any): boolean {
  if (cond && Array.isArray(cond.conditions)) {
    // Harper's planner rejects a one-condition `or` group.
    if (cond.operator === "or" && cond.conditions.length === 1) throw new Error("one-condition or group");
    const results = cond.conditions.map((c: any) => matches(record, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  if (cond.comparator === "equals") return record[cond.attribute] === cond.value;
  return true;
}

function baseFor(name: string) {
  return class {
    async get(target?: any) {
      const id = typeof target === "string" ? target : target?.id;
      return stores[name].get(id) ?? null;
    }
    search(query?: any) {
      const q = Array.isArray(query)
        ? { operator: "and", conditions: query }
        : {
            operator: query?.operator ?? "and",
            conditions: Array.isArray(query?.conditions) ? query.conditions : query?.conditions ? [query.conditions] : [],
          };
      const rows = Array.from(stores[name].values()).filter((r) => q.conditions.length === 0 || matches(r, q));
      async function* gen() {
        for (const r of rows) yield r;
      }
      return gen();
    }
  };
}

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: {
    flair: {
      Integration: baseFor("Integration"),
      MemoryUsage: baseFor("MemoryUsage"),
      MemoryGrant: baseFor("MemoryGrant"),
      Agent: { get: async () => null, search: async () => [] },
      // MemoryUsage reads show a row only about a memory the reader can read,
      // so the ledger rows below name memories that exist and are readable.
      Memory: { get: async (id: string) => stores.Memory?.get(id) ?? null, search: async () => [] },
    },
  },
  Resource: class {},
}));

const { Integration } = await import("../../resources/Integration.ts");
const { MemoryUsage } = await import("../../resources/MemoryUsage.ts");
const { MemoryGrant } = await import("../../resources/MemoryGrant.ts");

const agentCtx = (agentId: string) => ({ tpsAgent: agentId, tpsAgentIsAdmin: false });
function as(Cls: any, agentId: string) {
  const r: any = new Cls();
  r.getContext = () => ({ request: agentCtx(agentId) });
  return r;
}
async function ids(result: any): Promise<string[]> {
  const out: string[] = [];
  for await (const r of result) out.push(r.id);
  return out.sort();
}

beforeEach(() => {
  stores.Integration = new Map([
    ["int-a", { id: "int-a", agentId: "agent-a", platform: "x" }],
    ["int-b", { id: "int-b", agentId: "agent-b", platform: "y" }],
  ]);
  stores.Memory = new Map([
    ["m1", { id: "m1", agentId: "agent-a" }],
    ["m2", { id: "m2", agentId: "agent-b" }],
  ]);
  stores.MemoryUsage = new Map([
    ["use-a", { id: "use-a", agentId: "agent-a", memoryId: "m1" }],
    ["use-b", { id: "use-b", agentId: "agent-b", memoryId: "m2" }],
  ]);
  stores.MemoryGrant = new Map([
    ["g-ab", { id: "g-ab", ownerId: "agent-a", granteeId: "agent-b", scope: "read" }],
    ["g-cd", { id: "g-cd", ownerId: "agent-c", granteeId: "agent-d", scope: "read" }],
  ]);
});

const orQuery = (id: string) => ({ operator: "or", conditions: [{ attribute: "id", comparator: "equals", value: id }] });

describe("a caller-supplied top-level operator cannot widen the read scope", () => {
  it("Integration: an agent's collection read returns only its own rows", async () => {
    expect(await ids(await as(Integration, "agent-a").search(orQuery("int-b")))).toEqual([]);
    expect(await ids(await as(Integration, "agent-a").search(orQuery("int-a")))).toEqual(["int-a"]);
  });

  it("MemoryUsage: an agent's collection read returns only its own rows", async () => {
    expect(await ids(await as(MemoryUsage, "agent-a").search(orQuery("use-b")))).toEqual([]);
    expect(await ids(await as(MemoryUsage, "agent-a").search(orQuery("use-a")))).toEqual(["use-a"]);
  });

  it("MemoryGrant: a party reads its grants; a non-party reads none", async () => {
    expect(await ids(await as(MemoryGrant, "agent-b").search(orQuery("g-ab")))).toEqual(["g-ab"]);
    expect(await ids(await as(MemoryGrant, "agent-b").search(orQuery("g-cd")))).toEqual([]);
  });
});

describe("the caller's conditions are kept and still narrow", () => {
  it("a single condition object (not an array) filters the owner's rows", async () => {
    stores.Integration.set("int-a2", { id: "int-a2", agentId: "agent-a", platform: "z" });
    const one = { conditions: { attribute: "platform", comparator: "equals", value: "z" } };
    expect(await ids(await as(Integration, "agent-a").search(one))).toEqual(["int-a2"]);
  });

  it("several caller conditions keep the caller's operator inside their own group", async () => {
    stores.Integration.set("int-a2", { id: "int-a2", agentId: "agent-a", platform: "z" });
    const two = {
      operator: "or",
      conditions: [
        { attribute: "platform", comparator: "equals", value: "x" },
        { attribute: "platform", comparator: "equals", value: "y" },
      ],
    };
    expect(await ids(await as(Integration, "agent-a").search(two))).toEqual(["int-a"]);
  });
});

describe("by-id reads go through the shared gate", () => {
  it("owner reads its row; another agent gets 404", async () => {
    expect(await as(Integration, "agent-a").get("int-a")).toMatchObject({ id: "int-a" });
    const denied: any = await as(Integration, "agent-b").get("int-a");
    expect(denied instanceof Response && denied.status).toBe(404);
    const usageDenied: any = await as(MemoryUsage, "agent-b").get("use-a");
    expect(usageDenied instanceof Response && usageDenied.status).toBe(404);
  });

  it("either party reads a grant; a non-party gets 404", async () => {
    expect(await as(MemoryGrant, "agent-a").get("g-ab")).toMatchObject({ id: "g-ab" });
    expect(await as(MemoryGrant, "agent-b").get("g-ab")).toMatchObject({ id: "g-ab" });
    const denied: any = await as(MemoryGrant, "agent-c").get("g-ab");
    expect(denied instanceof Response && denied.status).toBe(404);
  });
});
