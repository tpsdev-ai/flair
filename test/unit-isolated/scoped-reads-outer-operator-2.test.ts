/**
 * Resource-level complements to scoped-reads-outer-operator.test.ts.
 * The table mock evaluates the OUTER operator and returns real fixture rows.
 * Keep one complete contract test per resource so every test detects removal
 * of that resource's scope, including the tests of privileged/anonymous paths.
 *
 * Mutations M-Asset, M-Credential, M-Relationship, M-MemoryCandidate:
 * in the named resource's scoped-search callback, replace
 *   super.search(q)
 * with
 *   super.search({ ...q, conditions: q.conditions.slice(1) })
 * This removes only the scope; the caller group stays. The first assertion
 * must then return foreign rows and fail.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

const stores: Record<string, Map<string, any>> = {};
const searches: Record<string, any[]> = {};

function iterable(value: any): boolean {
  return !!value && typeof value === "object"
    && typeof value[Symbol.iterator] === "function"
    && !(value instanceof URLSearchParams);
}

function conditions(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (iterable(value)) return Array.from(value);
  return value && typeof value === "object" ? [value] : [];
}

function matches(record: any, condition: any): boolean {
  if (Array.isArray(condition?.conditions)) {
    if (condition.operator === "or" && condition.conditions.length < 2) {
      throw new Error("an or group requires at least two conditions");
    }
    if (condition.operator !== "or" && condition.conditions.length === 0) {
      throw new Error("an and group requires at least one condition");
    }
    const results = condition.conditions.map((c: any) => matches(record, c));
    return condition.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  if (condition?.comparator === "equals") {
    return record[condition.attribute] === condition.value;
  }
  throw new Error("unsupported condition in table mock");
}

function baseFor(name: string) {
  return class {
    id?: string;

    async get(target?: any) {
      const id = typeof target === "string" ? target : target?.id ?? this.id;
      return stores[name].get(id) ?? null;
    }

    search(query?: any) {
      searches[name].push(query);
      const list = conditions(query?.conditions ?? (iterable(query) ? query : undefined));
      const group = { operator: query?.operator ?? "and", conditions: list };
      let rows = Array.from(stores[name].values()).filter((row) =>
        list.length === 0 && !query?.operator ? true : matches(row, group));
      if (query?.sort) {
        const { attribute, descending } = query.sort;
        rows.sort((a, b) => String(a[attribute]).localeCompare(String(b[attribute])) * (descending ? -1 : 1));
      }
      if (query?.limit != null) rows = rows.slice(0, query.limit);
      if (query?.select) {
        rows = rows.map((row) => Object.fromEntries(query.select.map((key: string) => [key, row[key]])));
      }
      async function* gen() {
        for (const row of rows) yield row;
      }
      return gen();
    }
  };
}

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: {
    flair: {
      Asset: baseFor("Asset"),
      Credential: baseFor("Credential"),
      Relationship: baseFor("Relationship"),
      MemoryCandidate: baseFor("MemoryCandidate"),
      Agent: { get: async () => null, search: async () => [] },
      Memory: { get: async () => null, search: async () => [] },
    },
  },
  Resource: class {},
  createBlob: () => { throw new Error("read tests must not create blobs"); },
}));

const { Asset } = await import("../../resources/Asset.ts");
const { Credential } = await import("../../resources/Credential.ts");
const { Relationship } = await import("../../resources/Relationship.ts");
const { MemoryCandidate } = await import("../../resources/MemoryCandidate.ts");

const resources = [
  { name: "Asset", Cls: Asset, ownerField: "agentId" },
  { name: "Credential", Cls: Credential, ownerField: "principalId" },
  { name: "Relationship", Cls: Relationship, ownerField: "agentId" },
  { name: "MemoryCandidate", Cls: MemoryCandidate, ownerField: "agentId" },
];

const keepDate = "2026-01-01T00:00:00.000Z";
const skipDate = "2026-02-01T00:00:00.000Z";
const eq = (attribute: string, value: string) => ({ attribute, comparator: "equals", value });
const keep = eq("createdAt", keepDate);
const orQuery = (...ids: string[]) => ({ operator: "or", conditions: ids.map((id) => eq("id", id)) });
const agentContext = (isAdmin = false) => ({
  request: { tpsAgent: "agent-a", tpsAgentIsAdmin: isAdmin },
});

function as(Cls: any, context: any) {
  const resource: any = new Cls();
  resource.getContext = () => context;
  return resource;
}

async function collect(result: any): Promise<any[]> {
  const rows: any[] = [];
  for await (const row of result) rows.push(row);
  return rows;
}

async function ids(result: any): Promise<string[]> {
  return (await collect(result)).map((row) => row.id).sort();
}

beforeEach(() => {
  for (const { name, ownerField } of resources) {
    stores[name] = new Map();
    searches[name] = [];
    for (const [id, owner, createdAt] of [
      ["a-keep", "agent-a", keepDate],
      ["a-skip", "agent-a", skipDate],
      ["b-keep", "agent-b", keepDate],
      ["b-skip", "agent-b", skipDate],
    ]) {
      const row: any = { id, [ownerField]: owner, createdAt };
      if (name === "Credential") {
        // Opposite agentId catches accidentally using the kit's default field.
        row.agentId = owner === "agent-a" ? "agent-b" : "agent-a";
        row.tokenHash = "stored-hash";
      }
      stores[name].set(id, row);
    }
  }
});

describe("shared scoped search preserves each resource's read contract", () => {
  for (const { name, Cls } of resources) {
    it(`${name}: scope, caller filters, query options and auth branches`, async () => {
      const owner = as(Cls, agentContext());

      // Both caller alternatives match foreign rows: removing ONLY the scope
      // makes this fail on returned rows, not on malformed-query rejection.
      expect(await ids(await owner.search(orQuery("b-keep", "b-skip")))).toEqual([]);
      expect(await ids(await owner.search(orQuery("a-keep", "b-keep")))).toEqual(["a-keep"]);
      expect(await ids(await owner.search(orQuery("a-keep", "a-skip")))).toEqual(["a-keep", "a-skip"]);
      expect(await ids(await owner.search({
        operator: "and",
        conditions: [eq("id", "a-keep"), eq("id", "a-skip")],
      }))).toEqual([]);

      // A matching foreign row and a non-matching owned row distinguish scope
      // loss from caller-filter loss for each accepted condition representation.
      for (const query of [
        { conditions: keep },
        { operator: "or", conditions: keep },
        { operator: "or", conditions: [keep] },
        { conditions: new Set([keep]) },
        { operator: "or", conditions: new Set([eq("id", "a-keep"), eq("id", "b-keep")]) },
        [keep],
        new Set([keep]),
        (function* () { yield keep; })(),
      ]) {
        expect(await ids(await owner.search(query))).toEqual(["a-keep"]);
        expect(searches[name].at(-1).operator).toBe("and");
      }

      // A query with no caller conditions returns exactly the caller's scoped rows.
      for (const query of [
        undefined, {}, [], new Set(), { operator: "or" },
        { conditions: [] }, { conditions: null }, { conditions: undefined },
        { conditions: false }, { conditions: 0 },
      ]) {
        expect(await ids(await owner.search(query))).toEqual(["a-keep", "a-skip"]);
        expect(searches[name].at(-1).operator).toBe("and");
      }

      const options = { select: ["id"], limit: 1, sort: { attribute: "id", descending: true } };
      for (const query of [
        { ...options, conditions: [keep] },
        Object.assign(new URLSearchParams(), options, { isCollection: true, conditions: [keep] }),
      ]) {
        expect(await collect(await owner.search(query))).toEqual([{ id: "a-keep" }]);
        const seen = searches[name].at(-1);
        expect(seen.select).toBe(options.select);
        expect(seen.limit).toBe(options.limit);
        expect(seen.sort).toBe(options.sort);
      }
      // Sorting/limiting must happen after scope filtering.
      expect(await collect(await owner.search(options))).toEqual([{ id: "a-skip" }]);

      const anonymous = as(Cls, { request: { tpsAnonymous: true } });
      expect(await anonymous.allowRead()).toBe(false);
      const beforeDenied = searches[name].length;
      const denied = await anonymous.search(orQuery("a-keep", "b-keep"));
      expect(denied).toBeInstanceOf(Response);
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: "authentication required" });
      expect(searches[name].length).toBe(beforeDenied);
      expect(await owner.allowRead()).toBe(true);

      for (const context of [agentContext(true), { __flairInternal: true }, undefined]) {
        const privileged = as(Cls, context);
        expect(await privileged.allowRead()).toBe(true);
        for (const query of [
          undefined,
          { ...options, ...orQuery("a-keep", "b-keep") },
          Object.assign([keep], options),
          Object.assign(new Set([keep]), options),
        ]) {
          expect(await ids(await privileged.search(query))).toEqual(
            query === undefined ? ["a-keep", "a-skip", "b-keep", "b-skip"] : ["b-keep"],
          );
          expect(searches[name].at(-1)).toBe(query);
        }
      }

      // get() is unchanged: Credential uses a URL-bound id, forbids with 403,
      // preserves missing-row null and strips tokenHash even for admin/internal.
      const get = async (resource: any, id: string) => {
        resource.id = id;
        return name === "Credential" ? resource.get() : resource.get(id);
      };
      expect(await get(owner, "a-keep")).toMatchObject({ id: "a-keep" });
      for (const resource of [owner, anonymous]) {
        const result = await get(resource, "b-keep");
        expect(result).toBeInstanceOf(Response);
        expect(result.status).toBe(name === "Credential" ? 403 : 404);
        expect(await result.json()).toEqual({ error: name === "Credential" ? "forbidden" : "not found" });
        const missing = await get(resource, "missing");
        if (name === "Credential") expect(missing).toBeNull();
        else expect(missing.status).toBe(404);
      }
      for (const context of [agentContext(true), { __flairInternal: true }]) {
        const privileged = as(Cls, context);
        expect(await get(privileged, "b-keep")).toMatchObject({ id: "b-keep" });
        expect(await get(privileged, "missing")).toBeNull();
        if (name === "Credential") expect(await get(privileged, "b-keep")).not.toHaveProperty("tokenHash");
      }
      if (name === "Credential") {
        expect(await get(owner, "a-keep")).not.toHaveProperty("tokenHash");
      } else {
        expect(await ids(await owner.get({ isCollection: true, ...orQuery("a-keep", "b-keep") }))).toEqual(["a-keep"]);
      }
    });
  }
});
