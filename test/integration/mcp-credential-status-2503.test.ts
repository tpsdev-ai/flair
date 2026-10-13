// mcp-credential-status-2503.test.ts — the MCP credential resolver and the
// principal linker accept a Credential only when its status is exactly "active".
//
// `resolveAgentFromSub` (resources/mcp-handler.ts) resolves a token subject
// through `Credential(kind:"idp", idpSubject=sub)` at request time, and
// `provisionIdpIdentityMapping` (src/lib/mcp-enable.ts) is the supported writer
// of that mapping. Before this change both accepted every status except
// "revoked", so a principal-bearing row with no status — or any unknown value —
// was served as a live mapping. And a revoked row was SKIPPED by the resolver,
// so JIT provisioning, when enabled, could re-create the principal the
// revocation was meant to stop. Any matching IdP row now prevents JIT fallback:
// the resolver scans for an active, principal-bearing row, refuses the call only
// if none maps, and JIT runs only when no IdP row matches the subject.
//
// Harness: a real Harper with the in-process fixture (test/fixtures/inproc-app),
// driving the SHIPPED `mcpHandler` through its `mcpRpc` op — the real
// `Credential` lookup against a real store, with `request.mcp = { sub }` (the
// post-withMCPAuth shape). JIT provisioning is ON here, because the property
// that a non-active mapping must not fall through to JIT is the point.
//
// Every ops/HTTP target is this test's own ephemeral instance (asserted below
// before the first call).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable.ts";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;
let opsPort: number;

const sfx = Date.now().toString(36);
// The principal an ACTIVE mapping resolves to. `agent-a` is a neutral fixture
// name, never a real fleet host.
const AGENT = `cs-agent-a-${sfx}`;

async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** One JSON-RPC tools/call through the REAL mcpHandler, as the given sub. */
async function mcpCall(sub: string, rpc: Record<string, unknown>): Promise<any> {
  const out = await fleet("mcpRpc", { sub, rpc });
  expect(out.ok, `mcpRpc transport failed: ${JSON.stringify(out).slice(0, 400)}`).toBe(true);
  return out.value.rpc;
}

const store = (sub: string, marker: string) =>
  mcpCall(sub, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: marker, visibility: "private" } } });

/**
 * The rows of `table` whose `attribute` equals `value`. A read that fails — a
 * non-2xx answer, a body that is not JSON, or JSON that is not a list — throws,
 * so an assertion that no row exists can pass only on a valid, empty read.
 */
async function adminSearch(table: string, attribute: string, value: string): Promise<any[]> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ operation: "search_by_value", database: "flair", table, search_attribute: attribute, search_value: value, get_attributes: ["*"] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`admin search ${table}.${attribute} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`admin search ${table}.${attribute} answered a body that is not JSON: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(body)) throw new Error(`admin search ${table}.${attribute} answered a non-list: ${text.slice(0, 300)}`);
  return body;
}

async function adminUpsert(table: string, records: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ operation: "upsert", database: "flair", table, records }),
  });
  if (!res.ok) throw new Error(`admin upsert ${table} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Every Agent row in this instance's store. Throws rather than answering [] on a failed read. */
async function allAgents(): Promise<any[]> {
  return adminSearch("Agent", "id", "*");
}

async function adminDelete(table: string, ids: string[]): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ operation: "delete", database: "flair", table, ids }),
  });
  if (!res.ok) throw new Error(`admin delete ${table} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const byId = (rows: any[]): any[] => [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

/** The full stored state a refused call must leave alone: every Credential row for `sub` and the whole Agent roster, all fields. */
async function storeSnapshot(sub: string): Promise<{ credentials: any[]; agents: any[] }> {
  return { credentials: byId(await adminSearch("Credential", "idpSubject", sub)), agents: byId(await allAgents()) };
}

/** Nothing was written: the subject's Credential rows and the Agent roster are deep-equal to the snapshot. */
function expectStoreUnchanged(before: { credentials: any[]; agents: any[] }, after: { credentials: any[]; agents: any[] }): void {
  expect(after.credentials, "the subject's Credential rows are unchanged (no row changed, removed, replaced or added)").toEqual(before.credentials);
  expect(after.agents, "the Agent roster is unchanged (no principal changed or added)").toEqual(before.agents);
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-credstatus-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  // JIT ON for the whole file: a revoked mapping must NOT fall through to it.
  const prior = process.env.FLAIR_MCP_JIT_PROVISION;
  process.env.FLAIR_MCP_JIT_PROVISION = "1";
  try {
    harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  } finally {
    if (prior === undefined) delete process.env.FLAIR_MCP_JIT_PROVISION;
    else process.env.FLAIR_MCP_JIT_PROVISION = prior;
  }
  // Talk only to this test's own ephemeral instance.
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
  opsPort = Number(ops.port);
  expect(harper.opsURL, `ephemeral ops API ${harper.opsURL}`).toBe(`http://127.0.0.1:${opsPort}`);
  const reg = await fleet("register", { id: AGENT });
  expect(reg.ok, JSON.stringify(reg)).toBe(true);
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#2503 — the /mcp resolver accepts a Credential only when its status is \"active\"", () => {
  test("an ACTIVE credential resolves through the real resolver (positive control)", async () => {
    const sub = `cs-sub-active-${sfx}`;
    await adminUpsert("Credential", [{
      id: `cs-cred-active-${sfx}`, kind: "idp", label: "cs", status: "active",
      idpProvider: "cs-idp", idpSubject: sub, principalId: AGENT, createdAt: new Date().toISOString(),
    }]);
    const rpc = await mcpCall(sub, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bootstrap", arguments: {} } });
    expect(rpc.error, JSON.stringify(rpc)).toBeUndefined();
    expect(rpc.result?.structuredContent?.agentId).toBe(AGENT);
  }, 60_000);

  for (const [label, status] of [["revoked", "revoked"], ["missing", undefined], ["unknown", "disabled"]] as const) {
    test(`a ${label}-status credential is refused by name, resolves nothing, and does not JIT-provision`, async () => {
      const sub = `cs-sub-${label}-${sfx}`;
      const credId = `cs-cred-${label}-${sfx}`;
      await adminUpsert("Credential", [{
        id: credId, kind: "idp", label: "cs", idpProvider: "cs-idp", idpSubject: sub, principalId: AGENT,
        createdAt: new Date().toISOString(),
        ...(status === undefined ? {} : { status }),
      }]);
      const before = await storeSnapshot(sub);
      expect(before.credentials.map((c) => [c.id, c.status ?? null]), "fixture control: the mapping row is present").toEqual([[credId, status ?? null]]);
      expect(before.agents.map((a) => a.id), "fixture control: the Agent roster answers").toContain(AGENT);

      const marker = `cs-marker-${label}-${sfx}`;
      const rpc = await store(sub, marker);

      // REFUSED BY NAME: the actor (the credential), the state (its status) and
      // the remedy (re-link) are all in the message.
      expect(rpc.result, `a ${label}-status credential must not resolve: ${JSON.stringify(rpc).slice(0, 300)}`).toBeUndefined();
      expect(rpc.error?.code).toBe(-32001);
      expect(rpc.error?.message).toContain(credId);
      expect(rpc.error?.message).toContain(`usable only when its status is "active"`);
      expect(rpc.error?.message).toContain(status === undefined ? "no status" : `status "${status}"`);
      expect(rpc.error?.message).toMatch(/re-link/);

      // NOTHING WRITTEN: no tool ran (no memory row), every Credential row for
      // the subject is deep-equal to the snapshot (all fields, none added,
      // removed or replaced), and so is the whole Agent roster (JIT did not run).
      expect(await adminSearch("Memory", "content", marker), "the refused call wrote no memory").toEqual([]);
      expectStoreUnchanged(before, await storeSnapshot(sub));
    }, 60_000);
  }
});

describe("flair#2503 — any matching IdP row prevents JIT fallback; the call is refused only if none maps", () => {
  // A Credential that names no principal. The current schema requires
  // principalId, and real storage refuses a row without the attribute (pinned
  // first). It does store an EMPTY principalId, which names no principal to
  // either the resolver or the linker, so that is the row the resolver is
  // exercised against here. The resolver does not rely on the schema to exclude
  // the attribute-less shape; the unit suite covers that one.
  test("real storage refuses a Credential with no principalId attribute (fixture control)", async () => {
    const sub = `cs-noattr-sub-${sfx}`;
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
      body: JSON.stringify({ operation: "upsert", database: "flair", table: "Credential", records: [{
        id: `cs-noattr-cred-${sfx}`, kind: "idp", label: "cs", status: "active", idpProvider: "cs-idp", idpSubject: sub,
        createdAt: new Date().toISOString(),
      }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("principalId is required");
    expect(await adminSearch("Credential", "idpSubject", sub)).toEqual([]);
  }, 60_000);

  for (const [label, status] of [["revoked", "revoked"], ["missing", undefined], ["active", "active"]] as const) {
    test(`a principal-less ${label}-status row is refused by name; no Agent and no Credential are created`, async () => {
      const sub = `cs-nop-sub-${label}-${sfx}`;
      const credId = `cs-nop-cred-${label}-${sfx}`;
      await adminUpsert("Credential", [{
        id: credId, kind: "idp", label: "cs", idpProvider: "cs-idp", idpSubject: sub, principalId: "",
        createdAt: new Date().toISOString(),
        ...(status === undefined ? {} : { status }),
      }]);
      const before = await storeSnapshot(sub);
      expect(before.credentials.map((c) => c.id), "fixture control: real storage holds the row").toEqual([credId]);
      expect(before.credentials[0].principalId, "fixture control: the stored row names no principal").toBe("");
      expect(before.credentials[0].status ?? null, "fixture control: the stored status").toBe(status ?? null);
      expect(before.agents.length, "fixture control: the Agent read answers").toBeGreaterThan(0);

      const marker = `cs-nop-marker-${label}-${sfx}`;
      const rpc = await store(sub, marker);

      expect(rpc.result, `a principal-less row must not resolve: ${JSON.stringify(rpc).slice(0, 300)}`).toBeUndefined();
      expect(rpc.error?.code).toBe(-32001);
      expect(rpc.error?.message).toContain(credId);
      expect(rpc.error?.message).toContain("names no principal");
      expect(rpc.error?.message).toContain(status === undefined ? "no status" : `status "${status}"`);
      expect(rpc.error?.message).toMatch(/re-link/);

      expect(await adminSearch("Memory", "content", marker), "the refused call wrote no memory").toEqual([]);
      expectStoreUnchanged(before, await storeSnapshot(sub));
    }, 60_000);
  }

  // The pair the rule has to order: one principal-less row and one active,
  // principal-bearing row for the same subject. The rule's outcome: the
  // subject resolves through the principal-bearing row, whichever row storage
  // returns first; the principal-less row is left unchanged, and no Credential
  // or Agent is created (JIT does not run).
  test("a principal-less row beside an ACTIVE principal-bearing row: the subject resolves through the principal-bearing row", async () => {
    const sub = `cs-pair-sub-${sfx}`;
    const nopId = `cs-pair-nop-${sfx}`;
    const liveId = `cs-pair-live-${sfx}`;
    const now = new Date().toISOString();
    await adminUpsert("Credential", [
      { id: nopId, kind: "idp", label: "cs", status: "active", idpProvider: "cs-idp", idpSubject: sub, principalId: "", createdAt: now },
      { id: liveId, kind: "idp", label: "cs", status: "active", idpProvider: "cs-idp", idpSubject: sub, principalId: AGENT, createdAt: now },
    ]);
    const before = await storeSnapshot(sub);
    expect(before.credentials.map((c) => c.id).sort(), "fixture control: both rows are stored").toEqual([liveId, nopId].sort());
    expect(before.credentials.find((c) => c.id === nopId)?.principalId, "fixture control: one row names no principal").toBe("");

    const rpc = await mcpCall(sub, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bootstrap", arguments: {} } });
    expect(rpc.error, JSON.stringify(rpc)).toBeUndefined();
    expect(rpc.result?.structuredContent?.agentId, "resolved through the principal-bearing row").toBe(AGENT);

    const after = await storeSnapshot(sub);
    expect(after.credentials.map((c) => c.id), "no Credential added or removed").toEqual(before.credentials.map((c) => c.id));
    expect(after.credentials.find((c) => c.id === nopId), "the principal-less row is unchanged").toEqual(before.credentials.find((c) => c.id === nopId));
    expect(after.agents, "the Agent roster is unchanged (JIT did not run)").toEqual(before.agents);
  }, 60_000);

  // The no-write comparison must be able to fire: each change a refused call
  // must not make (a row changed, a credential replaced, an Agent added) is made
  // here directly, and expectStoreUnchanged must reject it.
  test("the no-write comparison rejects a changed row, a replaced credential and an added Agent (check control)", async () => {
    const sub = `cs-probe-sub-${sfx}`;
    const credId = `cs-probe-cred-${sfx}`;
    const seed = { id: credId, kind: "idp", label: "cs", idpProvider: "cs-idp", idpSubject: sub, principalId: AGENT, createdAt: new Date().toISOString() };
    await adminUpsert("Credential", [seed]);
    const fails = async (change: () => Promise<void>, undo: () => Promise<void>) => {
      const before = await storeSnapshot(sub);
      expectStoreUnchanged(before, await storeSnapshot(sub)); // unchanged → passes
      await change();
      const after = await storeSnapshot(sub);
      await undo();
      expect(() => expectStoreUnchanged(before, after)).toThrow();
    };
    // A row changed (a field other than status).
    await fails(
      () => adminUpsert("Credential", [{ ...seed, label: "changed" }]),
      () => adminUpsert("Credential", [seed]),
    );
    // A credential replaced: the row removed and another with the same status written.
    const replacementId = `${credId}-replacement`;
    await fails(
      async () => { await adminDelete("Credential", [credId]); await adminUpsert("Credential", [{ ...seed, id: replacementId }]); },
      async () => { await adminDelete("Credential", [replacementId]); await adminUpsert("Credential", [seed]); },
    );
    // An Agent added.
    const extraAgent = `cs-probe-agent-${sfx}`;
    await fails(
      () => adminUpsert("Agent", [{ id: extraAgent, name: extraAgent, kind: "agent", type: "agent", status: "active", publicKey: `mcp-oauth:${sub}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]),
      () => adminDelete("Agent", [extraAgent]),
    );
  }, 60_000);

  test("JIT still provisions when no IdP Credential row matches the subject (positive control)", async () => {
    const sub = `cs-jit-sub-${sfx}`;
    expect(await adminSearch("Credential", "idpSubject", sub), "fixture control: no row matches").toEqual([]);
    const rpc = await mcpCall(sub, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bootstrap", arguments: {} } });
    expect(rpc.error, JSON.stringify(rpc)).toBeUndefined();
    const agentId = rpc.result?.structuredContent?.agentId;
    expect(agentId).toMatch(/^agt_mcp_/);
    const creds = await adminSearch("Credential", "idpSubject", sub);
    expect(creds.map((c) => [c.principalId, c.status])).toEqual([[agentId, "active"]]);
    expect((await allAgents()).filter((a) => a.id === agentId).map((a) => a.publicKey)).toEqual([`mcp-oauth:${sub}`]);
  }, 60_000);
});

describe("flair#2503 — the principal linker treats a non-active row as not a mapping", () => {
  test("a MISSING-status mapping is not reused: a fresh ACTIVE credential is written and the stale row is left alone", async () => {
    const sub = `cs-link-sub-${sfx}`;
    const principal = `cs-link-agent-${sfx}`;
    expect((await fleet("register", { id: principal })).ok).toBe(true);
    await adminUpsert("Credential", [{
      id: `cs-link-cred-${sfx}`, kind: "idp", label: "cs", idpProvider: "cs-idp",
      idpSubject: sub, principalId: principal, createdAt: new Date().toISOString(),
    }]);
    const mapping = await provisionIdpIdentityMapping({
      opsPortOrUrl: opsPort,
      adminUser: harper.admin.username,
      adminPass: harper.admin.password,
      principal,
      principalKind: "agent",
      idpProvider: "cs-idp",
      idpSubject: sub,
    });
    expect(mapping.credentialReused, "the stale row is not reused").toBe(false);
    expect(mapping.credentialId).not.toBe(`cs-link-cred-${sfx}`);
    const rows = await adminSearch("Credential", "idpSubject", sub);
    expect(rows.find((c) => c.id === `cs-link-cred-${sfx}`)?.status ?? null, "the stale row is unchanged").toBe(null);
    expect(rows.find((c) => c.id === mapping.credentialId)?.status).toBe("active");
  }, 60_000);
});
