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
