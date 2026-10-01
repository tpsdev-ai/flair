// ─── flair#2141 S2 — the using-flair seed against a real Harper ──────────────
//
// A fresh instance + one agent, with NO per-agent setup: POST /SkillSeed writes
// the using-flair skill row and its org assignment, and the agent's bootstrap
// lists `using-flair` under Active Skills. Then a re-run changes nothing; an
// operator edit is kept and reported. (The upgrade-from-a-shipped-hash and
// unreadable-refused cases live in test/unit/skill-seed.test.ts, where the
// decision and the fail-closed IO are exercised without inducing a real read
// failure.)
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const AGENT = mkAgent(`ufs-agent-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;

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

async function bootstrap(who: TestAgent): Promise<any> {
  const res = await fetch(`${harper.httpURL}/BootstrapMemories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519(who, "POST", "/BootstrapMemories") },
    body: JSON.stringify({ agentId: who.id, maxTokens: 4000 }),
  });
  const text = await res.text();
  expect(res.status, `bootstrap: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function skillSeed(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${harper.httpURL}/SkillSeed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: "{}",
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function memoryRow(): Promise<any> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: ["using-flair"], get_attributes: ["id", "agentId", "content", "tags", "durability", "visibility", "metadata"] });
  return Array.isArray(rows) ? rows[0] : null;
}

describe("flair#2141 S2 — seed a using-flair skill on install", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    // One agent, no skill-assignment — "no per-agent setup".
    await ops({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: AGENT.id, name: AGENT.id, kind: "agent", status: "active", role: "agent", publicKey: AGENT.publicKey, createdAt: now() }],
    });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("before the seed, the agent's bootstrap lists no using-flair", async () => {
    const boot = await bootstrap(AGENT);
    expect((boot.skills ?? []).map((s: any) => s.name)).not.toContain("using-flair");
  }, 30_000);

  test("the seed creates the skill row and its org assignment", async () => {
    const out = await skillSeed();
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.action).toBe("create");
    expect(out.body.skillId).toBe("using-flair");
    const row = await memoryRow();
    expect(row, "the using-flair Memory row exists").toBeTruthy();
    expect(row.agentId).toBe("flair-seed");
    expect(row.tags).toContain("skill");
    expect(row.durability).toBe("persistent");
    expect(row.visibility).toBe("shared");
  }, 30_000);

  test("the agent's bootstrap lists using-flair under Active Skills with no per-agent setup", async () => {
    const boot = await bootstrap(AGENT);
    const entry = (boot.skills ?? []).find((s: any) => s.name === "using-flair");
    expect(entry, JSON.stringify(boot.skills)).toEqual({
      name: "using-flair", skillId: "using-flair", scope: "org", priority: "standard", source: null,
    });
    // No own skill-assignment was written for the agent.
    const souls = await ops({ operation: "search_by_value", database: "flair", table: "Soul", search_attribute: "agentId", search_value: AGENT.id, get_attributes: ["id", "key"] });
    expect((souls ?? []).some((s: any) => s.key === "skill-assignment")).toBe(false);
  }, 30_000);

  test("a re-run changes nothing", async () => {
    const before = await memoryRow();
    const out = await skillSeed();
    expect(out.status).toBe(200);
    expect(out.body.action).toBe("unchanged");
    const after = await memoryRow();
    expect(after.content).toBe(before.content);
  }, 30_000);

  test("an operator-edited row is kept and reported", async () => {
    await ops({ operation: "update", database: "flair", table: "Memory", records: [{ id: "using-flair", content: "an operator's own text", updatedAt: now() }] });
    const out = await skillSeed();
    expect(out.status).toBe(200);
    expect(out.body.action).toBe("keep");
    expect(String(out.body.message)).toContain("operator");
    const row = await memoryRow();
    expect(row.content).toBe("an operator's own text");
  }, 30_000);
});
