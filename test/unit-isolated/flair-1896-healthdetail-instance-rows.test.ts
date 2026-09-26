/**
 * flair#1896 — /HealthDetail's `federation.instance` must not report an
 * arbitrary Instance row, nor a failed read as "no instance".
 *
 * Before this fix, `resources/health.ts` read the Instance rows with
 * `db.flair.Instance.search({})`, swallowed a failed read as "absent", and
 * reported `instances[0]` as the identity. With several rows the "answer" was a
 * coin toss (whichever row the unordered search yielded first); with a failed
 * read it read as a table with no identity — a silently wrong answer.
 *
 * GET /FederationInstance (flair#1883) already solved this: it reads through the
 * strict `readAllInstanceRows` (which throws on a row it cannot name) and
 * decides with `decideInstanceAnswer`. These cases drive the REAL `/HealthDetail`
 * resource with a mocked context and assert the `federation.instance` shape for
 * each outcome:
 *
 *   - one row                -> { id, role, status } (as today)
 *   - zero rows              -> null (as today)
 *   - more than one row      -> a refusal naming the prune, NOT a pick of one
 *      (admin also sees each row's id/role/createdAt; a non-admin sees only the
 *      count + remedy, no ids), and the answer is the SAME in either read order
 *   - a read that FAILS (or a row it cannot name) -> { unreadable: true },
 *      never null and never a pick.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock `harper` so importing the resource never touches a real (production)
// data dir. A permissive proxy supplies a no-op for any other named export the
// transitive import graph asks for (same idiom as the #1800 C2 test).
mock.module("harper", () => {
  const noop = () => {};
  const base: any = {
    server: { http: noop, getUser: async () => null },
    databases: { flair: {} },
    Resource: class {},
    logger: { info: noop, warn: noop, error: noop, debug: noop, trace: noop },
  };
  return new Proxy(base, {
    get: (t, p: string) => (p in t ? t[p] : noop),
  }) as any;
});

const harper = await import("harper");
const { HealthDetail } = await import("../../resources/health.ts");
const { INSTANCE_ROW_PRUNE_REMEDY } = await import("../../src/lib/instance-identity-row.ts");

// The one peer, used wherever a row that keeps the federation block built is
// needed (e.g. the "no instance row" case, where `federation.instance` must
// still be observed as `null` rather than a null whole block).
const PEER = {
  id: "peer-1",
  role: "spoke",
  status: "paired",
  lastSyncAt: "2026-01-01T00:00:00.000Z",
};

const ROW_A = {
  id: "inst-alpha",
  role: "hub",
  status: "active",
  publicKey: "k-alpha",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const ROW_B = {
  id: "inst-beta",
  role: "spoke",
  status: "paired",
  publicKey: "k-beta",
  createdAt: "2026-01-02T00:00:00.000Z",
};

function makeDetail(opts: { agent?: string; isAdmin?: boolean }): any {
  const d: any = new HealthDetail();
  d.getContext =
   opts.agent === undefined
      ? () => ({})
      : () => ({ request: { tpsAgent: opts.agent, tpsAgentIsAdmin: opts.isAdmin === true } });
  return d;
}

// Drive the mocked `databases.flair` (the same object both health.ts and
// readAllInstanceRows read through) to a known fixture between cases.
function setInstanceRead(kind: "rows" | "throw", rows: any[] = []): void {
  const flair: any = (harper.databases as any).flair;
  if (kind === "throw") {
    // A read that fails must not look like a table with no rows.
    flair.Instance = { search: () => { throw new Error("storage unavailable"); } };
  } else {
    flair.Instance = {
      search: async function*() {
        for (const r of rows) yield r;
       },
    };
  }
  // Peers/tokens: empty by default; callers override peers when they need the
  // federation block built.
  flair.Peer = {
    search: async function*() {
       // no rows
    },
  };
  flair.PairingToken = {
    search: async function*() {
       // no rows
    },
  };
}

function setPeers(rows: any[] = []): void {
  const flair: any = (harper.databases as any).flair;
  flair.Peer = {
    search: async function*() {
      for (const r of rows) yield r;
     },
  };
}

beforeEach(() => {
  (harper.databases as any).flair = {};
});

describe("flair#1896 — /HealthDetail federation.instance reports every Instance row, never a pick", () => {
  test("one row: federation.instance is the { id, role, status } of that row", async () => {
    setInstanceRead("rows", [ROW_A]);
    const stats: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();

    expect(stats.federation).not.toBeNull();
    expect(stats.federation.instance).toEqual({
      id: ROW_A.id,
      role: ROW_A.role,
      status: ROW_A.status,
    });
   });

  test("no row: federation.instance is null (not an arbitrary read, not absent)", async () => {
    // A peer keeps the federation block built so the `instance` field is
    // observed (with no peer the whole block would be null).
    setInstanceRead("rows", []);
    setPeers([PEER]);
    const stats: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();

    expect(stats.federation).not.toBeNull();
    expect(stats.federation.instance).toBeNull();
   });

  test("two rows (admin): a refusal naming the prune + every row, never a single-row pick", async () => {
    setInstanceRead("rows", [ROW_A, ROW_B]);
    const stats: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();

    const inst = stats.federation.instance;
    expect(inst.multiple).toBe(true);
    expect(inst.count).toBe(2);
    expect(inst.remedy).toBe(INSTANCE_ROW_PRUNE_REMEDY);
    // No single row is reported as the identity.
    expect("id" in inst).toBe(false);
    // The admin sees every row's id / role / createdAt, in read order.
    expect(inst.rows).toEqual([
      { id: ROW_A.id, role: ROW_A.role, createdAt: ROW_A.createdAt },
      { id: ROW_B.id, role: ROW_B.role, createdAt: ROW_B.createdAt },
    ]);
   });

  test("two rows (admin) in the other order: the same refusal, rows listed in read order", async () => {
    setInstanceRead("rows", [ROW_B, ROW_A]);
    const stats: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();

    const inst = stats.federation.instance;
    expect(inst.multiple).toBe(true);
    expect(inst.count).toBe(2);
    expect(inst.remedy).toBe(INSTANCE_ROW_PRUNE_REMEDY);
    expect("id" in inst).toBe(false);
    expect(inst.rows).toEqual([
      { id: ROW_B.id, role: ROW_B.role, createdAt: ROW_B.createdAt },
      { id: ROW_A.id, role: ROW_A.role, createdAt: ROW_A.createdAt },
    ]);
   });

  test("a row the reader cannot name: federation.instance is { unreadable: true }, not a smaller list", async () => {
    setInstanceRead("rows", [ROW_A, { role: "spoke", status: "active" }]);
    const stats: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();

    expect(stats.federation).not.toBeNull();
    expect(stats.federation.instance).toEqual({ unreadable: true });
   });

  test("two rows as non-admin: count + remedy, and NO ids are disclosed", async () => {
    setInstanceRead("rows", [ROW_A, ROW_B]);
    const stats: any = await makeDetail({ agent: "agent-x", isAdmin: false }).get();

    const inst = stats.federation.instance;
    expect(inst.multiple).toBe(true);
    expect(inst.count).toBe(2);
    expect(inst.remedy).toBe(INSTANCE_ROW_PRUNE_REMEDY);
    // No ids are disclosed to a non-admin: no top-level id, no per-row `rows`.
    expect("id" in inst).toBe(false);
    expect("rows" in inst).toBe(false);
    expect(JSON.stringify(inst)).not.toContain(ROW_A.id);
    expect(JSON.stringify(inst)).not.toContain(ROW_B.id);
   });

  test("two rows in EITHER order: the same refusal, no row picked (order-independent)", async () => {
    setInstanceRead("rows", [ROW_A, ROW_B]);
    const first: any = await makeDetail({ agent: "agent-x", isAdmin: false }).get();
    const instFirst = first.federation.instance;

    setInstanceRead("rows", [ROW_B, ROW_A]);
    setPeers([PEER]);
    const second: any = await makeDetail({ agent: "agent-x", isAdmin: false }).get();
    const instSecond = second.federation.instance;

    // The refusal is identical either way — no row was picked by read order.
    expect(instSecond).toEqual(instFirst);
    expect(instFirst.multiple).toBe(true);
    expect(instFirst.count).toBe(2);
    expect(instFirst.remedy).toBe(INSTANCE_ROW_PRUNE_REMEDY);
    expect("id" in instFirst).toBe(false);
   });

  test("a failed read: federation.instance is { unreadable: true }, never null and never a pick", async () => {
    setInstanceRead("throw");
    const stats: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();

    expect(stats.federation).not.toBeNull();
    expect(stats.federation.instance).toEqual({ unreadable: true });
   });
});
