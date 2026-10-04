/**
 * namespace-encoding.test.ts — flair#1939 round 2: namespace labels are stored
 * losslessly. LangGraph forbids `.` in labels, so `.` is the escape character:
 * `/` → `.2F`, `:` → `.3A`; every other character is unchanged. Each label is
 * encoded, then joined by `/`, and that string is the whole `lg-ns:` tag and
 * the middle of the id. A label that is empty, or that contains `.`, is
 * invalid and is refused before any id or tag is built.
 *
 * The FlairClient is replaced with an in-memory fake that records every call,
 * so each test can assert both the round-trip and that nothing reached the
 * backend for a refused/invalid namespace.
 */
import { describe, it, expect } from "bun:test";
import { FlairStore, parseStoredId } from "../src/index";
// Namespace import so a missing export (on the pre-fix head) is a runtime miss
// per test, not a whole-file link error.
import * as lg from "../src/index";

interface Row {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

function fakeClient(seed: Row[] = []) {
  const rows = seed.slice();
  const stats = { writes: 0, deletes: 0, gets: 0, lists: 0, searches: 0 };
  return {
    rows,
    stats,
    memory: {
      async write(content: string, opts: any = {}) {
        stats.writes++;
        rows.push({
          id: opts.id,
          content,
          tags: opts.tags ?? [],
          createdAt: new Date().toISOString(),
        });
      },
      async get(id: string) {
        stats.gets++;
        return rows.find((r) => r.id === id) ?? null;
      },
      async delete(id: string) {
        stats.deletes++;
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
      },
      async list(_opts: any = {}) {
        stats.lists++;
        return rows.slice().reverse();
      },
      async search(_q: string, _opts: any = {}) {
        stats.searches++;
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

describe("flair#1939 round 2 — namespace label encoding is lossless", () => {
  it("(e1) a label containing '/' round-trips: stored and searched as ONE label", async () => {
    const { store } = storeWith();
    await store.put(["a/b"], "k", { v: 1 });
    const out = await store.search(["a/b"]);
    expect(out.map((i) => i.namespace)).toEqual([["a/b"]]); // assertion: one label "a/b"
    expect(await store.search(["a", "b"])).toEqual([]); // assertion: not found as two labels
    expect(await store.get(["a", "b"], "k")).toBeNull(); // assertion: get with two labels is null
    expect((await store.get(["a/b"], "k"))?.value).toEqual({ v: 1 }); // assertion: get with the one label finds it
    // The encoding rule itself, including the edges LangGraph accepts.
    expect(lg.encodeLabel("a/b:c")).toBe("a.2Fb.3Ac"); // assertion: `/`→.2F, `:`→.3A
    expect(lg.decodeLabel(lg.encodeLabel("a/b:c"))).toBe("a/b:c"); // assertion: round-trip
  });

  it("(e2) ('a:b')/key 'c' and ('a')/key 'b:c' are two different items", async () => {
    const { store } = storeWith();
    await store.put(["a:b"], "c", { v: "colon-namespace" });
    await store.put(["a"], "b:c", { v: "colon-key" });
    expect((await store.get(["a:b"], "c"))?.value).toEqual({ v: "colon-namespace" }); // assertion: ns-key
    expect((await store.get(["a"], "b:c"))?.value).toEqual({ v: "colon-key" }); // assertion: key-colon
  });

  it("(e3) an item under ('a/') is not returned by search(('a',))", async () => {
    const { store } = storeWith();
    await store.put(["a/"], "k", { v: 1 });
    expect(await store.search(["a"])).toEqual([]); // assertion: label "a/" is not a child of ("a",)
  });

  it("(e4) a key containing ':' comes back unchanged from search and parseStoredId", async () => {
    const { store } = storeWith();
    await store.put(["a"], "b:c", { v: 1 });
    expect(parseStoredId("lg:agent1:a:b:c", "agent1")).toEqual({ namespace: ["a"], key: "b:c" }); // assertion: first `:` splits
    const out = await store.search(["a"]);
    expect(out.map((i) => i.key)).toEqual(["b:c"]); // assertion: key keeps its colon
  });

  it("(e5) a label containing '.' is refused and nothing reaches the backend", async () => {
    const { store, client } = storeWith();
    let err: unknown;
    try {
      await store.put(["a.b"], "k", { v: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error); // assertion: put refuses
    expect(String((err as Error).message)).toMatch(/LangGraph/); // assertion: names LangGraph's rule
    await expect(store.delete(["a.b"], "k")).rejects.toThrow(); // assertion: delete refuses
    expect(await store.get(["a.b"], "k")).toBeNull(); // assertion: get returns null
    expect(await store.search(["a.b"])).toEqual([]); // assertion: search returns []
    expect(client.stats).toEqual({ writes: 0, deletes: 0, gets: 0, lists: 0, searches: 0 }); // assertion: nothing sent
  });

  it("(e8) a label or key with an unpaired surrogate is refused and nothing reaches the backend", async () => {
    const { store, client } = storeWith();
    for (const [ns, key] of [
      [["x\uD800"], "k"],
      [["safe"], "x\uD800"],
      [["y\uDC00z"], "k"],
    ] as Array<[string[], string]>) {
      await expect(store.put(ns, key, { v: 1 })).rejects.toThrow(/well-formed/); // assertion: put refuses
      await expect(store.delete(ns, key)).rejects.toThrow(/well-formed/); // assertion: delete refuses
      expect(await store.get(ns, key)).toBeNull(); // assertion: get returns null
    }
    expect(await store.search(["x\uD800"])).toEqual([]); // assertion: search returns []
    const listed = await store.batch([
      { matchConditions: [{ matchType: "prefix", path: ["x\uD800"] }], limit: 10, offset: 0 } as any,
    ]);
    expect(listed[0]).toEqual([]); // assertion: an invalid listNamespaces condition matches nothing
    expect(client.stats).toEqual({ writes: 0, deletes: 0, gets: 0, lists: 0, searches: 0 }); // assertion: nothing sent
  });

  it("(e6) a row written in the old form for a plain label is still returned", async () => {
    const { store } = storeWith([
      {
        id: "lg:agent1:docs:report1",
        content: JSON.stringify({ v: 1 }),
        tags: ["lg-ns:docs"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect((await store.get(["docs"], "report1"))?.value).toEqual({ v: 1 }); // assertion: old-form id readable
    const out = await store.search(["docs"]);
    expect(out.map((i) => i.namespace)).toEqual([["docs"]]); // assertion: old-form tag still matches
  });

  it("(e7) The list-namespaces batch operation applies match conditions; invalid conditions reject previously stored invalid labels.", async () => {
    const { store } = storeWith([
      { id: "lg:agent1:docs/a:r1", content: "{}", tags: ["lg-ns:docs/a"], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "lg:agent1:docs/b:r2", content: "{}", tags: ["lg-ns:docs/b"], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "lg:agent1:other:r3", content: "{}", tags: ["lg-ns:other"], createdAt: "2026-01-01T00:00:00.000Z" },
      // An earlier version could store a label that decodes with a `.` in it;
      // this row's decoded namespace is ["old.name"].
      { id: "lg:agent1:old.name:r4", content: "{}", tags: ["lg-ns:old.name"], createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const all = (await store.batch([{ matchConditions: [], limit: 10, offset: 0 } as any]))[0];
    expect(all.map((n: string[]) => n.join("/")).sort()).toEqual(["docs/a", "docs/b", "old.name", "other"]); // assertion: no conditions → all (incl. the previously stored invalid label)
    const prefixed = (await store.batch([
      { matchConditions: [{ matchType: "prefix", path: ["docs"] }], limit: 10, offset: 0 } as any,
    ]))[0];
    expect(prefixed.map((n: string[]) => n.join("/")).sort()).toEqual(["docs/a", "docs/b"]); // assertion: prefix filter
    // An invalid condition label matches nothing, so it cannot select the
    // previously stored ["old.name"] row, whose label also contains ".".
    const invalid = (await store.batch([
      { matchConditions: [{ matchType: "prefix", path: ["old.name"] }], limit: 10, offset: 0 } as any,
    ]))[0];
    expect(invalid).toEqual([]); // assertion: an invalid condition rejects the previously stored invalid label
  });
});
