// ─── flair#2141 S1 — org-scope skill assignments against a real Harper ───────
//
// Harper routes each REST verb to its own resource method (PATCH does not go
// through put()), so the authority checks run over HTTP against a spawned,
// HOME-isolated Harper:
//   - Basic admin creates, replaces, patches and deletes; each write appends a
//     history row whose previousHash is the hash of the row before it, also
//     when several writes to one assignment arrive at once.
//   - An admin-agent key and a plain agent key are refused on every write verb
//     (PATCH by id included); anonymous callers reach no verb.
//   - Bootstrap over REST resolves the org assignment for an agent, lets a
//     higher-priority own assignment win, honours an operator opt-out stamped
//     with this instance's id (and not an unstamped one), and
//     gives a human, a deactivated agent and a missing target none.
//   - With the flair_agent role provisioned, a de-elevated agent reads the
//     table and cannot write it; a role set without the table's grant is
//     brought up to date when the server restarts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { FLAIR_AGENT_PERMISSION } from "../../src/lib/flair-agent-role";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const AGENT = mkAgent(`osa-agent-${sfx}`);
const ADMIN_AGENT = mkAgent(`osa-admin-${sfx}`);
const OWNER = `osa-owner-${sfx}`;   // owns the org skill row
const PRI = mkAgent(`osa-pri-${sfx}`); // has its own higher-priority assignment
const OPTED = mkAgent(`osa-opted-${sfx}`);
const UNSTAMPED = mkAgent(`osa-unstamped-${sfx}`); // has an opt-out row with no instance stamp
const HUMAN = `osa-human-${sfx}`;
const DEACT = `osa-deact-${sfx}`;
const ORG_NAME = `osa-using-flair-${sfx}`;
const ORG_ROW = `osa-org-row-${sfx}`;
const PRI_ROW = `osa-pri-row-${sfx}`;
const now = () => new Date().toISOString();

let harper: HarperInstance;
let installDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function call(auth: TestAgent | "basic" | "anonymous", method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth === "basic") headers.Authorization = basicAuth();
  else if (auth !== "anonymous") headers.Authorization = ed25519(auth, method, path);
  const res = await fetch(harper.httpURL + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

const upsert = (table: string, records: Record<string, unknown>[]) =>
  ops({ operation: "upsert", database: "flair", table, records });

async function assignmentsNamed(skillName: string): Promise<any[]> {
  return ops({ operation: "search_by_value", database: "flair", table: "OrgSkillAssignment", search_attribute: "skillName", search_value: skillName, get_attributes: ["*"] });
}

async function history(assignmentId: string): Promise<any[]> {
  const rows = await ops({ operation: "search_by_value", database: "flair", table: "OrgSkillAssignmentHistory", search_attribute: "assignmentId", search_value: assignmentId, get_attributes: ["*"] });
  return rows.sort((a: any, b: any) => a.at.localeCompare(b.at));
}

/** sha256 over the stored fields in the order the resource hashes them. */
function rowHash(row: Record<string, unknown>): string {
  const fields = ["id", "skillName", "skillRef", "priority", "createdAt", "updatedAt", "writer", "sourceClass"];
  return createHash("sha256").update(JSON.stringify(fields.map((f) => [f, row[f] ?? null]))).digest("hex");
}

/** Strip Harper's own metadata so two reads of the same row compare equal. */
const stored = (row: any) => Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => !k.startsWith("__")));

async function createViaOperator(skillName: string, skillRef = ORG_ROW, priority = "standard"): Promise<string> {
  const res = await call("basic", "POST", "/OrgSkillAssignment/", { skillName, skillRef, priority });
  expect(res.status, `operator POST: ${res.text.slice(0, 300)}`).toBeLessThan(300);
  const rows = await assignmentsNamed(skillName);
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function bootstrap(who: TestAgent, body: Record<string, unknown>): Promise<any> {
  const res = await call(who, "POST", "/BootstrapMemories", { includeSoul: false, ...body });
  expect(res.status, `bootstrap: ${res.text.slice(0, 300)}`).toBe(200);
  return JSON.parse(res.text);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  installDir = harper.installDir;
  assertOwnInstance(harper);
  await upsert("Agent", [
    ...[AGENT, PRI, OPTED, UNSTAMPED].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: now() })),
    { id: ADMIN_AGENT.id, name: ADMIN_AGENT.id, role: "admin", admin: true, publicKey: ADMIN_AGENT.publicKey, createdAt: now() },
    { id: OWNER, name: OWNER, role: "agent", publicKey: "pending", createdAt: now() },
    { id: HUMAN, name: HUMAN, kind: "human", publicKey: "pending", createdAt: now() },
    { id: DEACT, name: DEACT, status: "deactivated", publicKey: "pending", createdAt: now() },
  ]);
  const skill = (id: string, agentId: string) => ({
    id, agentId, tags: ["skill"], metadata: JSON.stringify({ name: ORG_NAME }),
    content: `procedure ${id}`, trigger: `when ${ORG_NAME} applies`,
    durability: "persistent", visibility: "shared", archived: false, createdAt: now(),
  });
  await upsert("Memory", [skill(ORG_ROW, OWNER), skill(PRI_ROW, PRI.id)]);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#2141 S1 — OrgSkillAssignment authority over HTTP", () => {
  test("Basic admin creates, replaces, patches and deletes; each write appends a history row with the previous row's hash", async () => {
    const name = `osa-lifecycle-${sfx}`;
    const created = await call("basic", "POST", "/OrgSkillAssignment/", {
      skillName: name, skillRef: ORG_ROW, priority: "standard", writer: "forged", sourceClass: "forged", extra: "dropped",
    });
    expect(created.status, created.text.slice(0, 300)).toBeLessThan(300);
    const [row] = await assignmentsNamed(name);
    expect(row.writer).toBe(harper.admin.username);
    expect(row.sourceClass).toBe("operator");
    expect(row.extra).toBeUndefined();
    let hist = await history(row.id);
    expect(hist.map((h) => [h.op, h.previousHash, h.actor, h.sourceClass])).toEqual([["create", null, harper.admin.username, "operator"]]);

    expect((await call("basic", "PUT", `/OrgSkillAssignment/${row.id}`, { skillName: name, skillRef: ORG_ROW, priority: "high" })).status).toBeLessThan(300);
    const afterPut = (await assignmentsNamed(name))[0];
    expect(afterPut.priority).toBe("high");
    expect(afterPut.createdAt).toBe(row.createdAt);
    hist = await history(row.id);
    expect(hist.map((h) => [h.op, h.previousHash])).toEqual([["create", null], ["update", rowHash(row)]]);

    expect((await call("basic", "PATCH", `/OrgSkillAssignment/${row.id}`, { priority: "low" })).status).toBeLessThan(300);
    const afterPatch = (await assignmentsNamed(name))[0];
    expect(afterPatch.priority).toBe("low");
    hist = await history(row.id);
    expect(hist.map((h) => h.op)).toEqual(["create", "update", "update"]);
    expect(hist[2].previousHash).toBe(rowHash(afterPut));

    expect((await call("basic", "DELETE", `/OrgSkillAssignment/${row.id}`)).status).toBeLessThan(300);
    expect(await assignmentsNamed(name)).toEqual([]);
    hist = await history(row.id);
    expect(hist.map((h) => h.op)).toEqual(["create", "update", "update", "delete"]);
    expect(hist[3].previousHash).toBe(rowHash(afterPatch));
    // The history table has no REST route, not even for Basic admin.
    const histPath = `/OrgSkillAssignmentHistory/${hist[0].id}`;
    for (const [method, path, body] of [
      ["GET", "/OrgSkillAssignmentHistory/", undefined],
      ["POST", "/OrgSkillAssignmentHistory/", { assignmentId: row.id, op: "create" }],
      ["PUT", histPath, { assignmentId: row.id, op: "create" }],
      ["PATCH", histPath, { op: "create" }],
      ["DELETE", histPath, undefined],
    ] as Array<[string, string, unknown]>) {
      expect((await call("basic", method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect(await history(row.id)).toHaveLength(4);
  }, 120_000);

  test("concurrent writes to one assignment record distinct predecessors that chain from the created row to the stored row", async () => {
    const name = `osa-concurrent-${sfx}`;
    const id = await createViaOperator(name);
    const created = (await assignmentsNamed(name))[0];
    const refs = Array.from({ length: 8 }, (_, i) => `osa-ref-${i}-${sfx}`);
    const results = await Promise.all(refs.map((skillRef) => call("basic", "PATCH", `/OrgSkillAssignment/${id}`, { skillRef })));
    expect(results.map((r) => r.status).filter((s) => s >= 300)).toEqual([]);
    const updates = (await history(id)).filter((h) => h.op === "update");
    expect(updates).toHaveLength(refs.length);
    expect(new Set(updates.map((h) => h.previousHash)).size).toBe(refs.length);
    // Walk the chain: the update whose predecessor is the current row, then the
    // row it left (one of the remaining refs, its updatedAt the update's `at`).
    const final = (await assignmentsNamed(name))[0];
    let state: Record<string, unknown> = created;
    const refsLeft = new Set(refs);
    const updatesLeft = new Set(updates);
    for (let step = 0; step < refs.length; step++) {
      const update = [...updatesLeft].find((u) => u.previousHash === rowHash(state));
      expect(update, `no update records the row at step ${step} as its predecessor`).toBeDefined();
      updatesLeft.delete(update);
      const last = updatesLeft.size === 0;
      const next = [...refsLeft]
        .map((skillRef) => ({ ...state, skillRef, updatedAt: update.at }))
        .find((row) => last ? rowHash(row) === rowHash(final) : [...updatesLeft].some((u) => u.previousHash === rowHash(row)));
      expect(next, `no ref continues the chain after step ${step}`).toBeDefined();
      refsLeft.delete(next!.skillRef as string);
      state = next!;
    }
    expect(refsLeft.size).toBe(0);
  }, 120_000);

  test("an admin-agent key and an agent key cannot create, replace, patch or delete; the row and its history are unchanged", async () => {
    const name = `osa-guarded-${sfx}`;
    const id = await createViaOperator(name);
    const before = stored((await assignmentsNamed(name))[0]);
    for (const who of [ADMIN_AGENT, AGENT]) {
      const attempts: Array<[string, string, unknown]> = [
        ["POST", "/OrgSkillAssignment/", { skillName: name, skillRef: ORG_ROW }],
        ["PUT", `/OrgSkillAssignment/${id}`, { skillName: name, skillRef: "elsewhere", priority: "critical" }],
        ["PATCH", `/OrgSkillAssignment/${id}`, { priority: "critical" }],
        ["DELETE", `/OrgSkillAssignment/${id}`, undefined],
      ];
      for (const [method, path, body] of attempts) {
        const res = await call(who, method, path, body);
        expect(res.status, `${who.id} ${method}: ${res.text.slice(0, 200)}`).toBe(403);
      }
    }
    const rows = await assignmentsNamed(name);
    expect(rows.map(stored)).toEqual([before]);
    expect((await history(id)).map((h) => h.op)).toEqual(["create"]);
  }, 120_000);

  test("no verb is reachable anonymously", async () => {
    const name = `osa-anon-${sfx}`;
    const id = await createViaOperator(name);
    const before = stored((await assignmentsNamed(name))[0]);
    for (const [method, path, body] of [
      ["GET", "/OrgSkillAssignment/", undefined],
      ["GET", `/OrgSkillAssignment/${id}`, undefined],
      ["POST", "/OrgSkillAssignment/", { skillName: name, skillRef: ORG_ROW }],
      ["PUT", `/OrgSkillAssignment/${id}`, { skillName: name, skillRef: ORG_ROW, priority: "critical" }],
      ["PATCH", `/OrgSkillAssignment/${id}`, { priority: "critical" }],
      ["DELETE", `/OrgSkillAssignment/${id}`, undefined],
    ] as Array<[string, string, unknown]>) {
      const res = await call("anonymous", method, path, body);
      expect([401, 403], `anonymous ${method} ${path}: ${res.status}`).toContain(res.status);
      expect(res.text).not.toContain(name);
    }
    expect((await assignmentsNamed(name)).map(stored)).toEqual([before]);
    expect((await history(id)).map((h) => h.op)).toEqual(["create"]);
  }, 120_000);

  test("a verified agent reads an assignment", async () => {
    const name = `osa-read-${sfx}`;
    const id = await createViaOperator(name);
    const res = await call(AGENT, "GET", `/OrgSkillAssignment/${id}`);
    expect(res.status, res.text.slice(0, 200)).toBe(200);
    expect(JSON.parse(res.text).skillName).toBe(name);
  }, 60_000);

  test("an opt-out is a Soul row: an agent key cannot write one, the operator can, and optOut must be a boolean", async () => {
    const id = `osa-optout-probe-${sfx}`;
    const row = { id, agentId: AGENT.id, key: "skill-assignment", value: ORG_NAME, metadata: JSON.stringify({ optOut: true }), createdAt: now() };
    expect((await call(AGENT, "PUT", `/Soul/${id}`, row)).status).toBe(403);
    const bad = await call("basic", "PUT", `/Soul/${id}`, { ...row, metadata: JSON.stringify({ optOut: "yes" }) });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("skill_opt_out_not_boolean");
    expect((await call("basic", "PUT", `/Soul/${id}`, row)).status).toBeLessThan(300);
    expect((await call("basic", "DELETE", `/Soul/${id}`)).status).toBeLessThan(300);
  }, 60_000);

  test("AgentSeed refuses a skill-assignment key in soulTemplate before writing anything", async () => {
    const agentId = `osa-seed-${sfx}`;
    const res = await call("basic", "POST", "/AgentSeed", { agentId, soulTemplate: { "skill-assignment": ORG_NAME } });
    expect(res.status).toBe(400);
    expect(res.text).toContain("skill_assignment_not_seedable");
    expect(await ops({ operation: "search_by_id", database: "flair", table: "Agent", ids: [agentId], get_attributes: ["id"] })).toEqual([]);
    expect(await ops({ operation: "search_by_value", database: "flair", table: "Soul", search_attribute: "agentId", search_value: agentId, get_attributes: ["id"] })).toEqual([]);
  }, 60_000);
});

describe("flair#2141 S1 — bootstrap over REST resolves org assignments", () => {
  const DANGLING = `osa-dangling-${sfx}`;
  let unstampedBeforeIdentity: any;
  beforeAll(async () => {
    await createViaOperator(ORG_NAME);
    await createViaOperator(DANGLING, `osa-no-such-row-${sfx}`);
    const assignment = (id: string, agentId: string, extra: Record<string, unknown>) =>
      call("basic", "PUT", `/Soul/${id}`, { id, agentId, key: "skill-assignment", value: ORG_NAME, createdAt: now(), ...extra });
    expect((await assignment(`osa-pri-a-${sfx}`, PRI.id, { priority: "high" })).status).toBeLessThan(300);
    // An opt-out with no stamp, written straight to the table, bootstrapped
    // while this instance has no identity row (its id reads as null).
    const instances = await ops({ operation: "search_by_value", database: "flair", table: "Instance", search_attribute: "id", search_value: "*", get_attributes: ["id"] });
    expect(instances, "a fresh test instance has no identity row yet").toEqual([]);
    await upsert("Soul", [{
      id: `osa-unstamped-a-${sfx}`, agentId: UNSTAMPED.id, key: "skill-assignment", value: ORG_NAME,
      metadata: JSON.stringify({ optOut: true }), createdAt: now(),
    }]);
    unstampedBeforeIdentity = await bootstrap(UNSTAMPED, {});
    // Then the instance gets its one identity row, and the operator writes an
    // opt-out, which the Soul resource stamps with that id.
    await upsert("Instance", [{ id: `osa-instance-${sfx}`, publicKey: "test-instance-key", role: "hub", status: "active", createdAt: now() }]);
    expect((await assignment(`osa-opt-a-${sfx}`, OPTED.id, { metadata: JSON.stringify({ optOut: true }) })).status).toBeLessThan(300);
    const opt = await ops({ operation: "search_by_id", database: "flair", table: "Soul", ids: [`osa-opt-a-${sfx}`], get_attributes: ["originatorInstanceId"] });
    expect(opt[0]?.originatorInstanceId).toBe(`osa-instance-${sfx}`);
  }, 120_000);

  test("an agent with no own assignment gets the org skill (scope org); an unresolved org skillRef is only in diagnostics", async () => {
    const res = await bootstrap(AGENT, {});
    expect(res.skills).toContainEqual({ name: ORG_NAME, skillId: ORG_ROW, scope: "org", priority: "standard", source: null });
    expect(res.skills.map((s: any) => s.name)).not.toContain(DANGLING);
    const dangling = res.skillDiagnostics.filter((d: any) => d.name === DANGLING);
    expect(dangling.map((d: any) => `${d.scope}:${d.decision}`)).toEqual(["org:unresolved"]);
  }, 60_000);

  test("a higher-priority own assignment wins and the org assignment is superseded", async () => {
    const res = await bootstrap(PRI, {});
    expect(res.skills.filter((s: any) => s.name === ORG_NAME)).toEqual([
      { name: ORG_NAME, skillId: PRI_ROW, scope: "own", priority: "high", source: null },
    ]);
    expect(res.skillDiagnostics.filter((d: any) => d.name === ORG_NAME).map((d: any) => `${d.scope}:${d.decision}`)).toEqual(["org:superseded"]);
  }, 60_000);

  test("an operator opt-out removes the org skill for that agent only", async () => {
    const res = await bootstrap(OPTED, {});
    expect(res.skills.map((s: any) => s.name)).not.toContain(ORG_NAME);
    expect(res.skillDiagnostics.map((d: any) => d.name)).not.toContain(ORG_NAME);
    expect((await bootstrap(AGENT, {})).skills.map((s: any) => s.name)).toContain(ORG_NAME);
  }, 60_000);

  test("an opt-out row with no instance stamp does not apply, with or without a readable instance id: the org skill stays", async () => {
    expect(unstampedBeforeIdentity.skills.map((s: any) => s.name)).toContain(ORG_NAME);
    expect((await bootstrap(UNSTAMPED, {})).skills.map((s: any) => s.name)).toContain(ORG_NAME);
  }, 60_000);

  test("a human, a deactivated agent and a missing target get no org skills", async () => {
    for (const target of [HUMAN, DEACT, `osa-missing-${sfx}`]) {
      const res = await bootstrap(ADMIN_AGENT, { agentId: target });
      expect(res.agentId).toBe(target);
      expect([...res.skills, ...res.skillDiagnostics].filter((e: any) => e.scope === "org"), target).toEqual([]);
    }
  }, 60_000);
});

describe("flair#2141 S1 — the flair_agent role and the startup check", () => {
  test("a de-elevated agent reads the table and cannot write it", async () => {
    assertOwnInstance(harper);
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
    const id = (await assignmentsNamed(ORG_NAME))[0].id;
    expect((await call(AGENT, "GET", `/OrgSkillAssignment/${id}`)).status).toBe(200);
    expect((await call(AGENT, "POST", "/OrgSkillAssignment/", { skillName: `osa-deelev-${sfx}`, skillRef: ORG_ROW })).status).toBe(403);
    expect((await call(AGENT, "PUT", `/OrgSkillAssignment/${id}`, { skillName: ORG_NAME, skillRef: ORG_ROW, priority: "critical" })).status).toBe(403);
    expect((await call(AGENT, "PATCH", `/OrgSkillAssignment/${id}`, { priority: "critical" })).status).toBe(403);
    expect((await call(AGENT, "DELETE", `/OrgSkillAssignment/${id}`)).status).toBe(403);
    expect((await assignmentsNamed(ORG_NAME))[0].priority).toBe("standard");
  }, 120_000);

  test("a role set without the org tables' grants is brought up to date at the next server start", async () => {
    const { OrgSkillAssignment: _a, OrgSkillAssignmentHistory: _h, ...olderTables } = FLAIR_AGENT_PERMISSION.flair.tables;
    const older = { ...FLAIR_AGENT_PERMISSION, flair: { tables: olderTables } };
    await ops({ operation: "alter_role", id: "flair_agent", role: "flair_agent", permission: older });
    const roleTables = async () => {
      const roles = await ops({ operation: "list_roles" });
      return roles.find((r: any) => r.role === "flair_agent")?.permission?.flair?.tables ?? {};
    };
    expect((await roleTables()).OrgSkillAssignment).toBeUndefined();

    await stopHarper(harper, { keepInstallDir: true });
    harper = await startHarper({ installDir });
    assertOwnInstance(harper);
    let tables: any = {};
    for (let i = 0; i < 50 && !tables.OrgSkillAssignment; i++) {
      tables = await roleTables();
      if (!tables.OrgSkillAssignment) await Bun.sleep(200);
    }
    expect(tables.OrgSkillAssignment).toEqual(FLAIR_AGENT_PERMISSION.flair.tables.OrgSkillAssignment);
    expect(tables.OrgSkillAssignmentHistory).toEqual(FLAIR_AGENT_PERMISSION.flair.tables.OrgSkillAssignmentHistory);
    // The stored spec reads back byte-identical, so the next start finds it unchanged.
    const roles = await ops({ operation: "list_roles" });
    expect(JSON.stringify(roles.find((r: any) => r.role === "flair_agent")?.permission)).toBe(JSON.stringify(FLAIR_AGENT_PERMISSION));
  }, 240_000);
});
