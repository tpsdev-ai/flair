// owner-field-guard-read-failure-callers.test.ts
//
// Callers other than Soul propagate the refusal when a non-admin agent's
// guard thunk fails. Integration returns it through its write-outcome denial
// object. These cases instantiate the real resource classes with a rejecting
// Harper base-table read and assert that no table write occurs.
//
// Soul's internal-call cases fail in its earlier `resolveStoredRow` read and
// return `stored_row_lookup_failed` (500). The guard does not backstop that read.
// The real-Harper test separately covers initial loads for addressed
// single-record PUT/PATCH, which return Harper's own 500 before the resource.
//
// Lives in test/unit-isolated/ because it mocks "harper" process-wide.
import { mock, describe, test, expect, beforeEach } from "bun:test";

// ─── Harper boundary: a base table whose read can be made to FAIL ────────────
//
// The real `databases.flair.<Table>` is both the base class each resource
// extends (instance get/put/...) and a table namespace with static reads
// (some helpers read through `databases.flair.X.get(...)`). Both faces are
// provided so the failure lands wherever the caller reads.
const writes: string[] = [];
let readFailureFrom = 1;
let readCalls = 0;

async function readStoredRow(): Promise<any> {
  readCalls += 1;
  if (readCalls >= readFailureFrom) throw new Error("injected stored-row read failure");
  return null;
}
function recordWrite(kind: string): any { writes.push(kind); return kind === "create" ? "generated-id" : null; }

class MockTable {
  async get(): Promise<any> { return readStoredRow(); }
  static async get(): Promise<any> { return readStoredRow(); }
  async put(..._a: any[]): Promise<any> { return recordWrite("put"); }
  static async put(..._a: any[]): Promise<any> { return recordWrite("put"); }
  async patch(..._a: any[]): Promise<any> { return recordWrite("patch"); }
  static async patch(..._a: any[]): Promise<any> { return recordWrite("patch"); }
  async post(..._a: any[]): Promise<any> { return recordWrite("post"); }
  static async post(..._a: any[]): Promise<any> { return recordWrite("post"); }
  async delete(..._a: any[]): Promise<any> { return recordWrite("delete"); }
  async create(..._a: any[]): Promise<any> { return recordWrite("create"); }
  static async create(..._a: any[]): Promise<any> { return recordWrite("create"); }
  // Async-iterable reads used by helper lookups (no rows).
  search(..._a: any[]): any[] { return []; }
  static search(..._a: any[]): any[] { return []; }
}

const tableCache = new Map<string, any>();
function tableFor(name: string) {
  if (!tableCache.has(name)) {
    const C = class extends MockTable {};
    (C as any).primaryStore = { tryLock: () => true, unlock: () => {}, resetReadTxn: () => {} };
    tableCache.set(name, C);
  }
  return tableCache.get(name)!;
}

mock.module("harper", () => ({
  databases: { flair: new Proxy({}, { get: (_t, p) => (typeof p === "string" ? tableFor(p) : undefined) }) },
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  models: {},
  createBlob: () => ({}),
  getContext: () => undefined,
  tables: {},
}));
// Harper's process-global transaction primitive (resources/request-transaction.ts).
(globalThis as any).transaction = async (ctx: any, cb: any) => cb(ctx);

const AGENT = { tpsAgent: "agent-a", tpsAgentIsAdmin: false };
const INTERNAL = { __flairInternal: true };

interface WriteCase {
  module: string;
  cls: string;
  verb: "put" | "patch";
  body: Record<string, any>;
  ctx: Record<string, any>;
  failFrom: number;
  /** The refusal layer that answers: the shared owner-field guard, or (Soul) resolveStoredRow. */
  via: "owner-guard" | "resolveStoredRow";
}

// At least the two mutating write verbs for every caller; Memory's PATCH reads
// the row once for the authority guard first, so its owner-guard read is the 2nd.
const CASES: WriteCase[] = [
  { module: "Asset", cls: "Asset", verb: "patch", body: { memoryId: "m", contentType: "image/png" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "Asset", cls: "Asset", verb: "put", body: { memoryId: "m", contentType: "image/png" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "Credential", cls: "Credential", verb: "patch", body: { status: "revoked" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "Credential", cls: "Credential", verb: "put", body: { kind: "bearer-token", status: "active" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "Integration", cls: "Integration", verb: "patch", body: { platform: "slack", username: "u" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "Integration", cls: "Integration", verb: "put", body: { platform: "slack", username: "u" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  // A Memory PUT names its id (flair#2478: an idless PUT is refused 400 before
  // any read). Read 1 is the stored-row resolver's read by that id (no row);
  // read 2, the owner guard's, is the one that fails.
  { module: "Memory", cls: "Memory", verb: "put", body: { id: "mem-owner-guard", content: "hi" }, ctx: AGENT, failFrom: 2, via: "owner-guard" },
  { module: "Memory", cls: "Memory", verb: "patch", body: { content: "hi" }, ctx: AGENT, failFrom: 2, via: "owner-guard" },
  { module: "MemoryCandidate", cls: "MemoryCandidate", verb: "patch", body: { status: "promoted" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "MemoryCandidate", cls: "MemoryCandidate", verb: "put", body: { status: "pending" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "MemoryGrant", cls: "MemoryGrant", verb: "patch", body: { scope: "all" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "MemoryGrant", cls: "MemoryGrant", verb: "put", body: { ownerId: "agent-b" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "OrgEvent", cls: "OrgEvent", verb: "patch", body: { summary: "s" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "OrgEvent", cls: "OrgEvent", verb: "put", body: { summary: "s" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "Relationship", cls: "Relationship", verb: "patch", body: { object: "o" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "Relationship", cls: "Relationship", verb: "put", body: { object: "o" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "WorkspaceState", cls: "WorkspaceState", verb: "patch", body: { ref: "main" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  { module: "WorkspaceState", cls: "WorkspaceState", verb: "put", body: { ref: "main" }, ctx: AGENT, failFrom: 1, via: "owner-guard" },
  // Soul writes are operator/internal only, so its owner guard passes those
  // callers through; its stored-row read failure is handled at resolveStoredRow.
  { module: "Soul", cls: "Soul", verb: "patch", body: { value: "v", agentId: "agent-a", key: "k" }, ctx: INTERNAL, failFrom: 1, via: "resolveStoredRow" },
  { module: "Soul", cls: "Soul", verb: "put", body: { value: "v", agentId: "agent-a", key: "k" }, ctx: INTERNAL, failFrom: 1, via: "resolveStoredRow" },
];

beforeEach(() => { writes.length = 0; readCalls = 0; readFailureFrom = 1; });

for (const c of CASES) {
  describe(`${c.cls}.${c.verb}`, () => {
    test(c.via === "owner-guard"
      ? "a non-admin agent's guard-thunk failure returns owner_check_unavailable without writing"
      : "Soul's resolver-read failure returns stored_row_lookup_failed without writing", async () => {
      const mod = await import(`../../resources/${c.module}.ts`);
      const inst = new mod[c.cls as keyof typeof mod]();
      (inst as any).getContext = () => c.ctx;
      // Soul's resolveStoredRow needs a URL-bound id to read the row it addresses.
      if (c.cls === "Soul") (inst as any).getId = () => "agent-a:k";
      writes.length = 0; readCalls = 0; readFailureFrom = c.failFrom;

      const res = await (inst as any)[c.verb](c.body, {});

      expect(res, `${c.cls}.${c.verb} did not return a refusal Response`).toBeInstanceOf(Response);
      expect(res.status, `${c.cls}.${c.verb} returned ${res.status}`).toBeGreaterThanOrEqual(400);
      const body = await res.clone().json();
      if (c.via === "owner-guard") {
        expect(body.error).toBe("owner_check_unavailable");
        expect(res.status).toBe(503);
      } else {
        expect(body.error).toBe("stored_row_lookup_failed");
      }
      expect(writes, `${c.cls}.${c.verb} reached the table despite the failed read`).toEqual([]);
    }, 30_000);
  });
}
