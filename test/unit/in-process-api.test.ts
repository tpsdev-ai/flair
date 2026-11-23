// in-process-api.test.ts — flair#956. Fast unit tests for the Flair facade
// that run without a build step (import from TypeScript source).
//
// The unit tests cover:
//   1. Import shape — Flair is exported from the module
//   2. as() guards — empty, blank, undefined, null, non-string all throw
//   3. Construction — new Flair(server) stores the server
//   4. Admin/Internal — separate, greppable properties exist
//
// The EXPORTS MAP is tested in test/integration/in-process-api.test.ts,
// which imports from "@tpsdev-ai/flair" (the package name) and therefore
// proves that `main` and `exports` in package.json resolve correctly.

import { describe, it, expect } from "bun:test";
import { Flair, AgentHandle, AdminHandle, InternalHandle, InProcessContextError } from "../../resources/in-process-api.ts";

// A minimal fake server that looks enough like Harper's Server to satisfy
// the facade's resource-resolution path.
function fakeServer(resources?: Record<string, any>) {
  const map = new Map(Object.entries(resources ?? {}));
  return {
    resources: {
      get: (name: string) => map.get(name),
      getMatch: (name: string) => map.get(name),
      keys: () => map.keys(),
    },
  } as any;
}

function fakeResourceEntry(Resource: any) {
  return { Resource, path: "Memory", exportTypes: {}, hasSubPaths: false, relativeURL: "" };
}

describe("Flair (public in-process API)", () => {
  // ── Import shape ───────────────────────────────────────────────────────

  it("exports Flair as a named export", () => {
    expect(Flair).toBeDefined();
    expect(typeof Flair).toBe("function");
  });

  it("exports AgentHandle, AdminHandle, InternalHandle", () => {
    expect(AgentHandle).toBeDefined();
    expect(AdminHandle).toBeDefined();
    expect(InternalHandle).toBeDefined();
  });

  it("re-exports InProcessContextError from the entry point", () => {
    expect(InProcessContextError).toBeDefined();
  });

  // ── Construction ───────────────────────────────────────────────────────

  it("new Flair(server) stores the server (lazy — no resource lookup at construction)", () => {
    const server = fakeServer();
    const flair = new Flair(server);
    expect(flair).toBeInstanceOf(Flair);
  });

  // ── as() guards ────────────────────────────────────────────────────────

  describe("flair.as() — identity guards", () => {
    const server = fakeServer();
    const flair = new Flair(server);

    it("as(\"\") throws InProcessContextError", () => {
      expect(() => flair.as("")).toThrow(InProcessContextError);
    });

    it("as(\" \") throws InProcessContextError (blank)", () => {
      expect(() => flair.as(" ")).toThrow(InProcessContextError);
    });

    it("as(\"   \") throws InProcessContextError (whitespace-only)", () => {
      expect(() => flair.as("   ")).toThrow(InProcessContextError);
    });

    it("as(undefined) throws — not a string", () => {
      // @ts-expect-error — testing the JS guard, not the TS type
      expect(() => flair.as(undefined)).toThrow(InProcessContextError);
    });

    it("as(null) throws — not a string", () => {
      // @ts-expect-error — testing the JS guard, not the TS type
      expect(() => flair.as(null)).toThrow(InProcessContextError);
    });

    it("as(123) throws — not a string", () => {
      // @ts-expect-error — testing the JS guard, not the TS type
      expect(() => flair.as(123)).toThrow(InProcessContextError);
    });

    it("as(\"planner\") returns an AgentHandle with the correct agentId", () => {
      const handle = flair.as("planner");
      expect(handle).toBeInstanceOf(AgentHandle);
      expect(handle.agentId).toBe("planner");
    });
  });

  // ── admin / internal properties ────────────────────────────────────────

  describe("flair.admin", () => {
    const server = fakeServer();
    const flair = new Flair(server);

    it("is an AdminHandle", () => {
      expect(flair.admin).toBeInstanceOf(AdminHandle);
    });

    it("is a property, not a method", () => {
      expect(typeof flair.admin).toBe("object");
    });

    it("returns the same handle on every access (flair#981)", () => {
      expect(flair.admin).toBe(flair.admin);
    });
  });

  describe("flair.internal", () => {
    const server = fakeServer();
    const flair = new Flair(server);

    it("is an InternalHandle", () => {
      expect(flair.internal).toBeInstanceOf(InternalHandle);
    });

    it("is a property, not a method", () => {
      expect(typeof flair.internal).toBe("object");
    });
  });

  // ── Resource-not-found error ───────────────────────────────────────────

  describe("resource resolution error", () => {
    it("throws with a helpful message when Flair is not loaded", async () => {
      const server = fakeServer(); // empty — no resources registered
      const flair = new Flair(server);
      const handle = flair.as("test-agent");
      await expect(handle.memory.write("hello")).rejects.toThrow(
        /Flair is not loaded in this Harper instance/,
      );
    });

    it("names the missing resource", async () => {
      const server = fakeServer(); // empty
      const flair = new Flair(server);
      const handle = flair.as("test-agent");
      await expect(handle.memory.write("hello")).rejects.toThrow(/Memory/);
    });

    it("lists available resources when some are registered", async () => {
      // Register a non-Memory resource so the error lists what IS there
      const server = fakeServer({
        Agent: fakeResourceEntry(class {}),
        Health: fakeResourceEntry(class {}),
      });
      const flair = new Flair(server);
      const handle = flair.as("test-agent");
      await expect(handle.memory.write("hello")).rejects.toThrow(/Agent, Health/);
    });
  });
});

// ─── flair#3068 — error responses reject ─────────────────────────────────────
//
// The facade's reads resolve to what they document. A refusal from the
// resource (a `Response` or an `{ error, status }` object) rejects instead of
// resolving to something a caller could mistake for a record. A 404 is the one
// exception: `memory.get()` resolves it to `null`.

function memoryReadStub(getImpl: (id: string, ctx: any) => any) {
  return fakeResourceEntry(
    class MemoryStub {
      static async get(id: string, ctx: any) {
        return getImpl(id, ctx);
      }
    },
  );
}

describe("flair#3068 — recall() rejects on an error response", () => {
  it("rejects a 429 Response with the error and its status", async () => {
    const server = fakeServer({
      SemanticSearch: fakeResourceEntry(
        class {
          async post() {
            return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { status: 429 });
          }
        },
      ),
    });
    await expect(new Flair(server).as("planner").recall("q")).rejects.toThrow(/rate_limit_exceeded.*HTTP 429/);
  });

  it("rejects an { error, status } object instead of resolving to it", async () => {
    const server = fakeServer({
      SemanticSearch: fakeResourceEntry(
        class {
          async post() {
            return { error: "bad", status: 500 };
          }
        },
      ),
    });
    await expect(new Flair(server).as("planner").recall("q")).rejects.toThrow(/bad.*HTTP 500/);
  });

  it("rejects when the search read throws", async () => {
    const server = fakeServer({
      SemanticSearch: fakeResourceEntry(
        class {
          async post() {
            throw new Error("storage unavailable");
          }
        },
      ),
    });
    await expect(new Flair(server).as("planner").recall("q")).rejects.toThrow(/storage unavailable/);
  });
});

describe("flair#3068 — memory.get() rejects on an error response", () => {
  it("rejects a 503 Response for an agent and for admin, and a 404 still resolves to null", async () => {
    const server = fakeServer({
      Memory: memoryReadStub((id) =>
        id === "missing" ? new Response(JSON.stringify({ error: "not found" }), { status: 404 }) : new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
      ),
    });
    const flair = new Flair(server);
    await expect(flair.as("planner").memory.get("m-1")).rejects.toThrow(/HTTP 503/);
    await expect(flair.admin.memory.get("m-1")).rejects.toThrow(/HTTP 503/);
    await expect(flair.as("planner").memory.get("missing")).resolves.toBeNull();
    await expect(flair.admin.memory.get("missing")).resolves.toBeNull();
  });

  it("rejects an { error, status } object instead of resolving to it", async () => {
    const server = fakeServer({
      Memory: memoryReadStub((id) =>
        id === "missing" ? { error: "not found", status: 404 } : { error: "unavailable", status: 503 },
      ),
    });
    const flair = new Flair(server);
    await expect(flair.as("planner").memory.get("m-1")).rejects.toThrow(/HTTP 503/);
    await expect(flair.admin.memory.get("m-1")).rejects.toThrow(/HTTP 503/);
    await expect(flair.as("planner").memory.get("missing")).resolves.toBeNull();
  });

  it("rejects when the storage read throws", async () => {
    const server = fakeServer({
      Memory: memoryReadStub(() => {
        throw new Error("storage unavailable");
      }),
    });
    const flair = new Flair(server);
    await expect(flair.as("planner").memory.get("m-1")).rejects.toThrow(/storage unavailable/);
    await expect(flair.admin.memory.get("m-1")).rejects.toThrow(/storage unavailable/);
  });
});

describe("flair#3068 — memory.search() rejects on an error response", () => {
  function searchStub(searchImpl: () => any) {
    return fakeResourceEntry(
      class MemoryStub {
        async search() {
          return searchImpl();
        }
      },
    );
  }

  it("rejects a 503 Response with the error and its status", async () => {
    const server = fakeServer({
      Memory: searchStub(() => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })),
    });
    await expect(new Flair(server).as("planner").memory.search()).rejects.toThrow(/unavailable.*HTTP 503/);
  });

  it("rejects an { error, status } object instead of resolving to it", async () => {
    const server = fakeServer({
      Memory: searchStub(() => ({ error: "bad", status: 500 })),
    });
    await expect(new Flair(server).as("planner").memory.search()).rejects.toThrow(/bad.*HTTP 500/);
  });

  it("rejects when the search read throws", async () => {
    const server = fakeServer({
      Memory: searchStub(() => {
        throw new Error("storage unavailable");
      }),
    });
    await expect(new Flair(server).as("planner").memory.search()).rejects.toThrow(/storage unavailable/);
  });
});

// ─── flair#3068 — the search limit has two halves ───────────────────────────
//
// `memory.search({ limit })` forwards the limit to the resource query AND caps
// what resolves back, because the resource may yield more rows than the limit
// it was handed. The stub below ignores `query.limit` and always yields five
// rows, as an array or as an async iterable.

function recordingMemorySearch(makeRows: () => any) {
  const calls: any[] = [];
  const entry = fakeResourceEntry(
    class MemoryStub {
      async search(query: any) {
        calls.push(query);
        return makeRows();
      }
    },
  );
  return { entry, calls };
}

const fiveRows = () => [1, 2, 3, 4, 5].map((n) => ({ id: `row-${n}`, agentId: "planner", content: `row ${n}` }));

describe("flair#3068 — memory.search() forwards and caps the limit", () => {
  it("forwards limit to the query and caps an array result", async () => {
    const { entry, calls } = recordingMemorySearch(() => fiveRows());
    const rows = await new Flair(fakeServer({ Memory: entry })).as("planner").memory.search({ limit: 2 });
    expect(calls[0]?.limit).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.id)).toEqual(["row-1", "row-2"]);
  });

  it("forwards limit to the query and caps an async-iterable result", async () => {
    const { entry, calls } = recordingMemorySearch(() =>
      (async function* () {
        for (const row of fiveRows()) yield row;
      })(),
    );
    const rows = await new Flair(fakeServer({ Memory: entry })).as("planner").memory.search({ limit: 2 });
    expect(calls[0]?.limit).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.id)).toEqual(["row-1", "row-2"]);
  });

  it("limit: 0 resolves to an empty array without reading", async () => {
    const { entry, calls } = recordingMemorySearch(() => fiveRows());
    const rows = await new Flair(fakeServer({ Memory: entry })).as("planner").memory.search({ limit: 0 });
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
