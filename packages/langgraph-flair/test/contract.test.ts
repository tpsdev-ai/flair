/**
 * contract.test.ts — flair#1943, the LangGraph slice.
 *
 * FlairStore is a LangGraph `BaseStore`. This file pins the contract four ways:
 *
 *   (t1) a RUNTIME method-presence check: every method name declared on
 *        `BaseStore.prototype` is a function on `FlairStore.prototype`.
 *   (t2) the TYPE CHECKER accepts `const s: BaseStore = new FlairStore({...})`.
 *        CI enforces it: from `packages/langgraph-flair` the unit lane runs
 *        `bunx tsc --noEmit --strict --target ES2022 --module ESNext
 *        --moduleResolution Bundler --types node,bun-types --esModuleInterop
 *        --skipLibCheck test/contract.test.ts`
 *        (scripts/test-unit.ts, after the flair-client build).
 *   (t3) a compiled `StateGraph` receives FlairStore via `compile({ store })`;
 *        a node writes through the store LangGraph hands it and a later node
 *        reads the value back through `get` and `search`.
 *   (t4) the public `listNamespaces()` returns exactly what the equivalent
 *        batch list-namespaces operation returns.
 *
 * The FlairClient is replaced with the same in-memory fake the existing tests
 * use (see namespace-encoding.test.ts): `memory.write/get/delete/list/search`
 * over a plain row array.
 */
import { describe, it, expect } from "bun:test";
import { BaseStore, type ListNamespacesOperation } from "@langchain/langgraph-checkpoint";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { FlairStore } from "../src/index";

// ── (t2) type-level check ──────────────────────────────────────────────────
// FlairStore must be assignable to LangGraph's BaseStore. The body is never
// called at runtime; `bunx tsc --noEmit` on this file is the assertion.
export function _flairStoreIsABaseStore(): BaseStore {
  const s: BaseStore = new FlairStore({ agentId: "contract-check" });
  return s;
}
void _flairStoreIsABaseStore;

// ── the shared in-memory fake client ───────────────────────────────────────
interface Row {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

function fakeClient(seed: Row[] = []) {
  const rows = seed.slice();
  return {
    rows,
    memory: {
      async write(content: string, opts: any = {}) {
        rows.push({ id: opts.id, content, tags: opts.tags ?? [], createdAt: new Date().toISOString() });
      },
      async get(id: string) {
        return rows.find((r) => r.id === id) ?? null;
      },
      async delete(id: string) {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
      },
      async list(_opts: any = {}) {
        return rows.slice().reverse();
      },
      async search(_q: string, _opts: any = {}) {
        return rows.slice().reverse();
      },
    },
  };
}

function storeWith(seed: Row[] = []) {
  const client = fakeClient(seed);
  const store = new FlairStore({ agentId: "agent1" });
  (store as any).client = client;
  return { store, client };
}

// ── (t1) structural interface ──────────────────────────────────────────────
describe("(t1) FlairStore carries every method BaseStore declares", () => {
  it("every name on BaseStore.prototype (minus constructor) is a function on FlairStore.prototype", () => {
    const baseMethods = Object.getOwnPropertyNames(BaseStore.prototype).filter((n) => n !== "constructor");
    // Sanity: the interface really does require these three (they are what the
    // audit found missing on main).
    expect(baseMethods).toContain("listNamespaces"); // assertion: required
    expect(baseMethods).toContain("start"); // assertion: required
    expect(baseMethods).toContain("stop"); // assertion: required
    const missing = baseMethods.filter((n) => typeof (FlairStore.prototype as any)[n] !== "function");
    expect(missing).toEqual([]); // assertion: nothing missing
  });
});

// ── (t3) end to end through a compiled StateGraph ──────────────────────────
const ContractState = Annotation.Root({
  readBack: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
  searchKeys: Annotation<string[]>({ reducer: (_p, n) => n, default: () => [] }),
});

describe("(t3) a compiled StateGraph hands FlairStore to its nodes", () => {
  it("writes in one node and reads it back via get and search in a later node", async () => {
    const { store } = storeWith();
    const graph = new StateGraph(ContractState)
      .addNode("write", async (_state: any, runtime: any) => {
        // The store LangGraph hands the node — not a closed-over reference.
        await runtime.store.put(["users", "profiles"], "user123", { name: "Alice" });
        return {};
      })
      .addNode("read", async (_state: any, runtime: any) => {
        const item = await runtime.store.get(["users", "profiles"], "user123");
        const found = await runtime.store.search(["users"]);
        return { readBack: item?.value?.name ?? null, searchKeys: found.map((i: any) => i.key) };
      })
      .addEdge(START, "write")
      .addEdge("write", "read")
      .addEdge("read", END)
      .compile({ store });

    const out: any = await graph.invoke({});
    expect(out.readBack).toBe("Alice"); // assertion: get returned the written value
    expect(out.searchKeys).toContain("user123"); // assertion: search found the item
  });
});

// ── (t4) listNamespaces vs the equivalent batch operation ──────────────────
describe("(t4) listNamespaces equals the equivalent batch operation", () => {
  it("listNamespaces({ prefix, maxDepth, limit }) returns the batch result", async () => {
    const { store } = storeWith([
      { id: "lg:agent1:docs/a:r1", content: "{}", tags: ["lg-ns:docs/a"], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "lg:agent1:docs/b:r2", content: "{}", tags: ["lg-ns:docs/b"], createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "lg:agent1:docs/c/deep:r3", content: "{}", tags: ["lg-ns:docs/c/deep"], createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "lg:agent1:other:r4", content: "{}", tags: ["lg-ns:other"], createdAt: "2026-01-04T00:00:00.000Z" },
    ]);

    const viaMethod = await store.listNamespaces({ prefix: ["docs"], maxDepth: 2, limit: 5 });
    const viaBatch = (await store.batch([
      {
        matchConditions: [{ matchType: "prefix", path: ["docs"] }],
        maxDepth: 2,
        limit: 5,
        offset: 0,
      } as ListNamespacesOperation,
    ]))[0];

    expect(viaMethod).toEqual(viaBatch); // assertion: identical results
    expect(viaMethod.length).toBeGreaterThan(0); // assertion: not vacuously empty
  });

  it("listNamespaces defaults limit to 100 and offset to 0, like BaseStore", async () => {
    const { store } = storeWith([
      { id: "lg:agent1:solo:r1", content: "{}", tags: ["lg-ns:solo"], createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(await store.listNamespaces()).toEqual([["solo"]]); // assertion: no options works
    expect(await store.listNamespaces({})).toEqual([["solo"]]); // assertion: empty options works
  });
});
