import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const agent = (id: string) => ({ id, ...nacl.sign.keyPair() });
const owner = agent("authority-owner"), other = agent("authority-other");
let harper: HarperInstance;
const now = new Date().toISOString();
const headers = (who: typeof owner, method: string, path: string) => {
  const ts = String(Date.now()), nonce = randomUUID();
  const signature = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return { "Content-Type": "application/json", Authorization: `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(signature).toString("base64")}` };
};
async function request(who: typeof owner, method: string, path: string, body?: unknown) {
  return fetch(harper.httpURL + path, { method, headers: headers(who, method, path), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function op(body: Record<string, unknown>) {
  const response = await fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json();
}
async function seed(table: string, records: Record<string, unknown>[]) {
  return op({ operation: "upsert", database: "flair", table, records });
}
const read = async (id: string) => (await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] }))[0];
beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  await seed("Agent", [owner, other].map(a => ({ id: a.id, name: a.id, role: "agent", publicKey: Buffer.from(a.publicKey).toString("base64"), createdAt: now })));
}, 120_000);
afterAll(async () => { if (harper) await stopHarper(harper); });

describe("Memory authority fields over HTTP", () => {
  test("direct PUT and PATCH cannot forge, clear or replace workflow stamps", async () => {
    await seed("Memory", [{ id: "stamped", agentId: owner.id, content: "original", durability: "persistent", createdAt: now, promotionStatus: "approved", promotedAt: now, promotedBy: "trusted-reviewer" }]);
    for (const method of ["PUT", "PATCH"]) {
      for (const field of ["promotionStatus", "promotedAt", "promotedBy"]) {
        for (const value of ["forged", null]) {
          const response = await request(owner, method, "/Memory/stamped", { [field]: value });
          expect(response.status).toBe(403);
        }
      }
    }
    const stored = await read("stamped");
    expect(stored.promotionStatus).toBe("approved");
    expect(stored.promotedBy).toBe("trusted-reviewer");
    for (const field of ["promotionStatus", "promotedAt", "promotedBy"]) {
      expect((await request(owner, "PUT", `/Memory/new-${field}`, { id: `new-${field}`, agentId: owner.id, content: "new", [field]: "forged" })).status).toBe(403);
      expect(await read(`new-${field}`)).toBeUndefined();
    }
  });
  test("administrator REST writes cannot manufacture verdicts either", async () => {
    for (const method of ["PUT", "PATCH"]) {
      const response = await fetch(`${harper.httpURL}/Memory/stamped`, {
        method, headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
        body: JSON.stringify({ promotionStatus: "rejected" }),
      });
      expect(response.status).toBe(403);
    }
  });
  test("ordinary metadata edits preserve existing authority stamps", async () => {
    const existing = await read("stamped");
    const patch = await request(owner, "PATCH", "/Memory/stamped", { durability: "standard", archived: true });
    expect(patch.status).toBe(204);
    const updated = await read("stamped");
    for (const field of ["promotionStatus", "promotedAt", "promotedBy"]) expect(updated[field]).toBe(existing[field]);
    expect(updated.content).toBe("original");
    expect((await request(owner, "PUT", "/Memory/stamped", { ...updated, durability: "persistent" })).status).toBe(200);
    const afterPut = await read("stamped");
    for (const field of ["promotionStatus", "promotedAt", "promotedBy"]) expect(afterPut[field]).toBe(existing[field]);
  }, 120_000);
  test("a content-changing write cannot keep an echoed approved verdict", async () => {
    const existing = await read("stamped");
    const put = await request(owner, "PUT", "/Memory/stamped", {
      id: "stamped", agentId: owner.id, content: "unreviewed claim under an echoed stamp",
      durability: "persistent", promotionStatus: existing.promotionStatus, promotedAt: existing.promotedAt, promotedBy: existing.promotedBy,
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const afterPut = await read("stamped");
    expect(afterPut.content).toBe("unreviewed claim under an echoed stamp");
    expect(afterPut.promotionStatus).toBeFalsy();
    expect(afterPut.promotedBy).toBeFalsy();
    await seed("Memory", [{ id: "stamped-patch", agentId: owner.id, content: "original", durability: "persistent", createdAt: now, promotionStatus: "approved", promotedAt: now, promotedBy: "trusted-reviewer" }]);
    const patch = await request(owner, "PATCH", "/Memory/stamped-patch", { content: "patched unreviewed claim" });
    expect(patch.status, await patch.clone().text()).toBe(204);
    const afterPatch = await read("stamped-patch");
    expect(afterPatch.content).toBe("patched unreviewed claim");
    expect(afterPatch.promotionStatus).toBeFalsy();
  }, 120_000);
  test("POST /FeedMemories cannot land a forged promotion verdict", async () => {
    const id = "feed-forged-verdict";
    const response = await request(owner, "POST", "/FeedMemories", {
      id, agentId: owner.id, content: "feed authority forge fixture",
      promotionStatus: "approved", promotedAt: now, promotedBy: "forged-reviewer",
    });
    expect(response.status).toBe(403);
    expect(await read(id)).toBeUndefined();
    const ok = await request(owner, "POST", "/FeedMemories", {
      id: "feed-clean", agentId: owner.id, content: "ordinary feed write without a verdict",
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const stored = await read("feed-clean");
    expect(stored.content).toBe("ordinary feed write without a verdict");
    for (const field of ["promotionStatus", "promotedAt", "promotedBy"]) expect(stored[field]).toBeUndefined();
  }, 120_000);
  test("the review workflow owns content, reviewer identity and verdict", async () => {
    await seed("MemoryCandidate", [{ id: "candidate", agentId: owner.id, claim: "Promotion workflow fixture about release verification.", status: "pending", generatedAt: now, createdAt: now, sourceMemoryIds: [], scopeTag: "adk:continuity:authority", visibilityRuling: "private" }]);
    expect((await request(other, "POST", "/PromoteMemoryCandidate", { candidateId: "candidate", rationale: "reviewed" })).status).toBe(404);
    expect((await request(owner, "POST", "/PromoteMemoryCandidate", { candidateId: "candidate", rationale: "reviewed", reviewerId: "someone-else" })).status).toBe(403);
    expect((await request(owner, "POST", "/PromoteMemoryCandidate", { candidateId: "candidate", rationale: "" })).status).toBe(400);
    const result = await request(owner, "POST", "/PromoteMemoryCandidate", { candidateId: "candidate", rationale: "verified release procedure", content: "forged", promotionStatus: "rejected" });
    expect(result.status, await result.clone().text()).toBe(200);
    const decision = await result.json();
    const memory = await read(decision.memoryId);
    expect(memory.content).toBe("Promotion workflow fixture about release verification.");
    expect(memory.promotionStatus).toBe("approved");
    expect(memory.promotedBy).toBe(owner.id);
    expect(memory.promotedAt).toBe(decision.decidedAt);
    expect(memory.durability).toBe("persistent");
    expect(memory.visibility).toBe("private");
    expect(memory.tags[0]).toBe("adk:continuity:authority");
    expect((await request(owner, "POST", "/PromoteMemoryCandidate", { candidateId: "candidate", rationale: "again" })).status).toBe(409);
  }, 120_000);
  test("REST permanent-memory lifecycle is owner-controlled, with admin override", async () => {
    const id = "owner-permanent";
    const created = await request(owner, "PUT", `/Memory/${id}`, { id, agentId: owner.id, content: "Owner-controlled permanent lifecycle fixture.", durability: "permanent" });
    expect(created.status).toBe(200);
    expect((await request(other, "DELETE", `/Memory/${id}`)).status).toBe(403);
    expect((await read(id)).durability).toBe("permanent");
    expect((await request(owner, "DELETE", `/Memory/${id}`)).status).toBe(200);
    expect(await read(id)).toBeUndefined();
    await seed("Memory", [{ id, agentId: owner.id, content: "Administrator deletion fixture.", durability: "permanent", createdAt: now }]);
    const adminDeleted = await fetch(`${harper.httpURL}/Memory/${id}`, { method: "DELETE", headers: { Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` } });
    expect(adminDeleted.status).toBe(200);
    expect(await read(id)).toBeUndefined();
  }, 120_000);
  test("the built REM CLI promotes through the trusted server workflow", async () => {
    await seed("MemoryCandidate", [{ id: "cli-candidate", agentId: owner.id, claim: "CLI promotion fixture for release rollback verification.", status: "pending", generatedAt: now, createdAt: now, sourceMemoryIds: [] }]);
    const home = await mkdtemp(join(tmpdir(), "flair-authority-cli-"));
    try {
      await writeFile(join(home, `${owner.id}.key`), owner.secretKey.slice(0, 32), { mode: 0o600 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
      const child = Bun.spawn(["bun", "dist/cli.js", "rem", "promote", "cli-candidate", "--to", "memory", "--rationale", "verified rollback procedure"], {
        env: { ...env, HOME: home, FLAIR_URL: harper.httpURL, FLAIR_AGENT_ID: owner.id, FLAIR_KEY_DIR: home }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0);
      const id = stdout.match(/Wrote Memory (\S+)/)?.[1];
      expect(id).toBeDefined();
      const memory = await read(id!);
      expect(memory.promotionStatus).toBe("approved");
      expect(memory.promotedBy).toBe(owner.id);
      expect(memory.durability).toBe("persistent");
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 120_000);

});
