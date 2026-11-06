// ─── flair#2997 — a schema failure on a server-built row answers 5xx ────────
//
// A caller row that fails Harper's schema validation keeps its 400 (the
// instruction-version append's validationErrorResponse). Rows the server builds
// itself — the InstructionVersion record, its OrgEvent, the skill successor —
// are pre-validated with their own table's validator before staging, so a
// server defect answers the write's 5xx shape and commits nothing.
//
// Real, HOME-isolated Harper; the invalid server-built rows come from the
// existing test-only fault hook (test/fixtures/skill-write-fault-2139/probe.js).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { componentWithReplayProbe, type ProbeComponent, type ProbeFiles } from "../helpers/component-with-replay-probe";

const FAULT_PROBE: ProbeFiles = {
  source: join("test", "fixtures", "skill-write-fault-2139", "probe.js"),
  target: join("dist", "resources", "zz-skill-write-fault-2139.js"),
  out: "skill-write-fault-2139", // unused: the probe writes no files
};
/** The owner-id prefix the probe hands an invalid row to (see the probe). */
const MUTATE_PREFIX = "__flair_fault_mutate__";
/** Server-built row each step corrupts. */
const STEPS = ["successor", "append", "event"] as const;

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`rowval-owner-${sfx}`);
const MUTATE = Object.fromEntries(STEPS.map((s) => [s, mkAgent(`${MUTATE_PREFIX}${s}`)])) as
  Record<(typeof STEPS)[number], TestAgent>;
const now = () => new Date().toISOString();

let harper: HarperInstance;
let installDir = "";
let composed: ProbeComponent | undefined;

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

async function call(auth: TestAgent | "basic", method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers.Authorization = auth === "basic" ? basicAuth() : ed25519(auth, method, path);
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

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

async function eventsOf(agentId: string): Promise<any[]> {
  return ops({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "scope", search_value: agentId, get_attributes: ["id", "kind"],
  });
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

async function memoryRowsBySubject(subjectId: string): Promise<any[]> {
  return ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "skillSubjectId", search_value: subjectId, get_attributes: ["id"],
  });
}

async function soulRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const soulPath = (id: string) => `/Soul/${encodeURIComponent(id)}`;
function skillBody(who: TestAgent, id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, agentId: who.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent", ...extra };
}

let seq = 0;
const nextId = (label: string) => `rowval-${label}-${sfx}-${++seq}`;

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  composed = componentWithReplayProbe({ probe: FAULT_PROBE });
  harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
  installDir = harper.installDir;
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [A, ...STEPS.map((s) => MUTATE[s])].map((a) => ({
      id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: now(),
    })),
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
  composed?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#2997 — the caller's row keeps its 400", () => {
  test("a caller field failing schema validation answers 400 naming it and commits nothing", async () => {
    const key = `rowval-invalid-${sfx}`;
    const id = `${A.id}:${key}`;
    const res = await call("basic", "PUT", soulPath(id), { id, agentId: A.id, key, value: 123 });
    expect(res.status, res.text.slice(0, 300)).toBe(400);
    const body = JSON.parse(res.text);
    expect(body.code).toBe("ValidationError");
    expect(body.detail.some((issue: any) => issue.path === "value"), JSON.stringify(body.detail)).toBe(true);
    expect(await soulRow(id)).toBeNull();
    expect(await versionsOf(`${A.id}:${key}`)).toHaveLength(0);
  }, 120_000);
});

describe("flair#2997 — an invalid server-built row answers 5xx and commits nothing", () => {
  for (const step of STEPS) {
    test(`an invalid ${step} row leaves the predecessor, versions and events unchanged`, async () => {
      const agent = MUTATE[step];
      const id = nextId(`invalid-${step}`);
      await ops({
        operation: "upsert", database: "flair", table: "Memory",
        records: [{
          id, agentId: agent.id, content: "v1", trigger: "t", tags: ["skill"],
          skillSubjectId: id, durability: "persistent", visibility: "shared", createdAt: now(),
        }],
      });
      const before = await memoryRow(id);
      const res = await call(agent, "PUT", memPath(id), skillBody(agent, id, "v2", { visibility: "shared" }));
      expect(res.status, res.text.slice(0, 300)).toBe(500);
      expect(JSON.parse(res.text).error).toBe("instruction_version_append_failed");

      const after = await memoryRow(id);
      expect(after).toEqual(before);
      expect((await memoryRowsBySubject(id)).map((row: any) => row.id), "no successor may survive").toEqual([id]);
      expect(await versionsOf(id), "no version row may survive").toHaveLength(0);
      expect(await eventsOf(agent.id), "no event may survive").toHaveLength(0);
    }, 120_000);
  }
});

describe("flair#2997 — a valid write is unchanged", () => {
  test("a valid Memory write stores the supplied row", async () => {
    const id = nextId("memory-valid");
    const res = await call(A, "PUT", memPath(id), { id, agentId: A.id, content: "a plain note", durability: "standard" });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    expect(await memoryRow(id)).toMatchObject({ id, agentId: A.id, content: "a plain note" });
  }, 120_000);

  test("a valid Soul write stores the supplied value and records its version", async () => {
    const key = `rowval-soul-${sfx}`;
    const id = `${A.id}:${key}`;
    const res = await call("basic", "PUT", soulPath(id), { id, agentId: A.id, key, value: "v1" });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    expect(await soulRow(id)).toMatchObject({ id, agentId: A.id, key, value: "v1" });
    expect((await versionsOf(`${A.id}:${key}`)).map((row) => row.kind)).toEqual(["create"]);
  }, 120_000);

  test("a valid skill write stores its successor and both versions", async () => {
    const id = nextId("skill-valid");
    expect((await call(A, "PUT", memPath(id), skillBody(A, id, "v1", { visibility: "shared" }))).status).toBeLessThan(300);
    const update = await call(A, "PUT", memPath(id), skillBody(A, id, "v2", { visibility: "shared" }));
    expect(update.status, update.text.slice(0, 300)).toBeLessThan(300);
    const successor = JSON.parse(update.text).id;
    expect(await memoryRow(successor)).toMatchObject({ id: successor, agentId: A.id, content: "v2" });
    expect((await versionsOf(id)).map((row) => row.kind)).toEqual(["create", "update"]);
    expect((await eventsOf(A.id)).filter((event: any) => event.kind === "skill.changed")).toHaveLength(2);
  }, 120_000);
});
