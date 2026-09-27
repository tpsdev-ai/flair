/**
 * search.test.ts — flair#1939: a queryless parent-prefix search returns items
 * stored under DESCENDANT namespaces. The listing is a prefix match on the
 * stored full-namespace tag (`lg-ns:<a/b/c>`), component boundary respected;
 * existing items need no migration (the match reads the tag they carry).
 *
 * The FlairClient is replaced with a mock that honours `tags`/`limit` exactly
 * as the real client-side filter does, so the pre-fix behaviour (exact-tag
 * listing) is reproduced here.
 */
import { describe, it, expect } from "bun:test";
import { FlairStore, namespaceTagMatches } from "../src/index";

function row(ns: string[], key: string, value: Record<string, any> = { k: key }) {
  const joined = ns.join("/");
  return {
    id: `lg:agent1:${joined}:${key}`,
    content: JSON.stringify(value),
    tags: [`lg-ns:${joined}`],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A mock client whose `memory.list`/`memory.search` honour tags + limit like the real one. */
function mockClient(rows: any[]) {
  return {
    memory: {
      list: async (opts: any = {}) => {
        let out = rows.slice();
        for (const tag of opts.tags ?? []) {
          out = out.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
        }
        if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
        return out;
      },
      search: async (_q: string, opts: any = {}) => {
        let out = rows.slice();
        if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
        return out;
      },
      get: async () => null,
      write: async () => {},
      delete: async () => {},
    },
  };
}

function storeWith(rows: any[]): FlairStore {
  const s = new FlairStore({ agentId: "agent1" });
  (s as any).client = mockClient(rows);
  return s;
}

const nsOf = (items: any[]) => items.map((i) => i.namespace.join("/")).sort();

describe("flair#1939 — a parent-prefix search returns descendants", () => {
  it("(d1) a parent-prefix search returns items stored under a child namespace", async () => {
    const store = storeWith([
      row(["a", "b"], "k1"),
      row(["a", "b", "c"], "k2"),
      row(["a", "bc"], "k3"),
    ]);
    const out = await store.search(["a"]);
    expect(nsOf(out)).toContain("a/b"); // assertion: the direct child
    expect(nsOf(out)).toContain("a/b/c"); // assertion: the grandchild
  });

  it("(d2) ('a','b') does not return an item in ('a','bc')", async () => {
    const store = storeWith([row(["a", "b"], "k1"), row(["a", "bc"], "k3")]);
    const out = await store.search(["a", "b"]);
    expect(nsOf(out)).toEqual(["a/b"]); // assertion: component boundary respected
  });

  it("(d3) an empty prefix returns items from every namespace of the agent", async () => {
    const store = storeWith([row(["a", "b"], "k1"), row(["a", "bc"], "k2"), row(["docs"], "k3")]);
    const out = await store.search([]);
    expect(nsOf(out)).toEqual(["a/b", "a/bc", "docs"]); // assertion: all namespaces
  });

  it("(d4) with more matching items than the old cap, limit N returns N (no short page)", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => row(["a", "b"], `k${i}`));
    const store = storeWith(rows);
    const out = await store.search(["a"], { limit: 5 });
    expect(out).toHaveLength(5); // assertion: a full page, not a short one
  });

  it("(d5) semantic search keeps its prefix filtering (no-regression guard)", async () => {
    const store = storeWith([row(["a", "b"], "k1"), row(["docs"], "k2")]);
    const out = await store.search(["a"], { query: "anything" });
    expect(nsOf(out)).toEqual(["a/b"]); // assertion: only the a-prefixed item
  });

  it("namespaceTagMatches: component boundary and empty prefix", () => {
    expect(namespaceTagMatches(["lg-ns:a/b"], ["a"])).toBe(true); // assertion
    expect(namespaceTagMatches(["lg-ns:a/b/c"], ["a", "b"])).toBe(true); // assertion
    expect(namespaceTagMatches(["lg-ns:a/bc"], ["a", "b"])).toBe(false); // assertion: boundary
    expect(namespaceTagMatches(["lg-ns:a/bc", "other"], [])).toBe(true); // assertion: empty prefix
    expect(namespaceTagMatches(["other"], ["a"])).toBe(false); // assertion: non-lg tag
  });
});
