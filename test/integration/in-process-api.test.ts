// in-process-api.test.ts — flair#956. Integration test that imports the Flair
// facade the way a CONSUMER would: from the package name, not a relative path.
// This is the test that proves the exports map in package.json resolves
// correctly. If `main` or `exports` is wrong or absent, this test fails.
//
// Requires a build (`bun run build`) because the entry point is a compiled
// artifact. The fast unit tests in test/unit/in-process-api.test.ts import
// from TypeScript source and run without a build.

import { describe, it, expect } from "bun:test";
import { Flair, AgentHandle, AdminHandle, InternalHandle, InProcessContextError } from "@tpsdev-ai/flair";

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

describe("Flair — package entry point (integration)", () => {
  // ── The exports map resolves ──────────────────────────────────────────

  it("Flair is importable from @tpsdev-ai/flair", () => {
    expect(Flair).toBeDefined();
    expect(typeof Flair).toBe("function");
  });

  it("AgentHandle, AdminHandle, InternalHandle are importable", () => {
    expect(AgentHandle).toBeDefined();
    expect(AdminHandle).toBeDefined();
    expect(InternalHandle).toBeDefined();
  });

  it("InProcessContextError is importable", () => {
    expect(InProcessContextError).toBeDefined();
  });

  // ── Construction ───────────────────────────────────────────────────────

  it("new Flair(server) constructs", () => {
    const server = fakeServer();
    const flair = new Flair(server);
    expect(flair).toBeInstanceOf(Flair);
  });

  // ── as() guards ────────────────────────────────────────────────────────

  describe("flair.as() — identity guards", () => {
    const server = fakeServer();
    const flair = new Flair(server);

    it('as("") throws InProcessContextError', () => {
      expect(() => flair.as("")).toThrow(InProcessContextError);
    });

    it('as(" ") throws InProcessContextError (blank)', () => {
      expect(() => flair.as(" ")).toThrow(InProcessContextError);
    });

    it('as("planner") returns an AgentHandle with the correct agentId', () => {
      const handle = flair.as("planner");
      expect(handle).toBeInstanceOf(AgentHandle);
      expect(handle.agentId).toBe("planner");
    });
  });

  // ── admin / internal properties ────────────────────────────────────────

  it("flair.admin is an AdminHandle", () => {
    const flair = new Flair(fakeServer());
    expect(flair.admin).toBeInstanceOf(AdminHandle);
  });

  it("flair.internal is an InternalHandle", () => {
    const flair = new Flair(fakeServer());
    expect(flair.internal).toBeInstanceOf(InternalHandle);
  });

  // ── Resource-not-found error ───────────────────────────────────────────

  it("throws with a helpful message when Flair is not loaded", async () => {
    const server = fakeServer(); // empty — no resources registered
    const flair = new Flair(server);
    const handle = flair.as("test-agent");
    await expect(handle.memory.write("hello")).rejects.toThrow(
      /Flair is not loaded in this Harper instance/,
    );
  });
});
