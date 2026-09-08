// Memory skill-write path guards — integration (flair#1542).
//
// The write slice (components 1-3) gated skill-tagged writes on Memory.post()
// and Memory.put(). This file guards the OTHER agent-reachable write paths
// that bypass those two verbs — the #1537 raw-writer lesson: gate EVERY verb,
// not just post/put. Each path must reject-or-gate a skill-tagged write:
//
//   PATCH /Memory/<id>      → 400 skill_write_path (rejectSkillWritePath)
//   POST /FeedMemories      → gated (SkillScan + forced durability)
//   POST /FederationSync    → skip skill_not_federated (never merge a skill)
//   POST /AgentSeed         → 400 skill_write_path (admin-only seed)
//
// Mutation-verify: on the pre-fix head, each GUARD test below fails (the
// skill-tagged write lands unscanned / durability=standard / merged raw).
// On the fixed head, they pass.
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { signBodyFresh } from "../../resources/federation-crypto.js";

const agent = (id: string) => ({ id, ...nacl.sign.keyPair() });
const owner = agent("skill-path-owner");
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
const readMemory = async (id: string) => (await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] }))[0];
const operator = async (method: string, path: string, body?: unknown) => fetch(harper.httpURL + path, {
  method,
  headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  await seed("Agent", [{ id: owner.id, name: owner.id, role: "agent", publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: now }]);
}, 120_000);
afterAll(async () => { if (harper) await stopHarper(harper); });

describe("Memory skill-write path guards (flair#1542)", () => {
  // ─── PATCH /Memory/<id> rejects a skill-tagged patch ──────────────────────

  test("GUARD: PATCH /Memory/<id> rejects a skill-tagged patch (400 skill_write_path)", async () => {
    await seed("Memory", [{ id: "skill-patch", agentId: owner.id, content: "original", durability: "persistent", createdAt: now }]);
    const res = await request(owner, "PATCH", "/Memory/skill-patch", { tags: ["skill"], trigger: "when to use", content: "procedure" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("skill_write_path");
    // The row is untouched — the patch did not land.
    const after = await readMemory("skill-patch");
    expect(after.content).toBe("original");
    expect(after.tags).toBeUndefined();
  }, 30_000);

  test("POSITIVE CONTROL: PATCH /Memory/<id> still updates a non-skill row", async () => {
    await seed("Memory", [{ id: "skill-patch-ok", agentId: owner.id, content: "original", durability: "persistent", createdAt: now }]);
    const res = await request(owner, "PATCH", "/Memory/skill-patch-ok", { content: "updated" });
    expect(res.status).toBe(204);
    const after = await readMemory("skill-patch-ok");
    expect(after.content).toBe("updated");
  }, 30_000);

  // ─── RESIDUAL (flair#1546, Kern #1543 review 5135715289): a patch to a row ──
  // whose STORED tags already include `skill` must be rejected — even when the
  // patch BODY carries no tags. Pre-residual, rejectSkillWritePath saw only the
  // body, so `{content}` on an existing skill landed UNSCANNED: a skill's
  // procedure could be rewritten (here, with a dangerous shell payload) past the
  // SkillScan gate. FAILS ON CURRENT MAIN: pre-fix this PATCH returns 204 and the
  // content changes.
  test("GUARD (residual): PATCH content on an EXISTING skill row is rejected unscanned (400 skill_write_path)", async () => {
    await seed("Memory", [{
      id: "skill-patch-existing", agentId: owner.id, content: "original procedure",
      tags: ["skill"], trigger: "when to use", durability: "persistent", createdAt: now,
    }]);
    // NOTE: no `tags` in the patch body — isSkillWrite(body) is false. Only the
    // STORED tags make this a skill write, which is exactly the residual.
    const res = await request(owner, "PATCH", "/Memory/skill-patch-existing", { content: "```bash\nrm -rf /\n```" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("skill_write_path");
    // The skill's procedure is untouched — the unscanned patch did not land.
    const after = await readMemory("skill-patch-existing");
    expect(after.content).toBe("original procedure");
  }, 30_000);

  // ─── POST /FeedMemories gates a skill-tagged write ────────────────────────

  test("GUARD: POST /FeedMemories rejects a dangerous skill (400 skill_scan_rejected)", async () => {
    const res = await request(owner, "POST", "/FeedMemories", {
      agentId: owner.id,
      content: "```bash\nexec(rm -rf /)\n```",
      tags: ["skill"],
      trigger: "run this",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("skill_scan_rejected");
  }, 30_000);

  test("GUARD: POST /FeedMemories forces a clean skill to durability=persistent", async () => {
    const res = await request(owner, "POST", "/FeedMemories", {
      agentId: owner.id,
      content: "a safe procedure",
      tags: ["skill"],
      trigger: "when to use",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The forced-persistent tier must survive the raw put (not 30-day-reapable "standard").
    expect(body.durability).toBe("persistent");
  }, 30_000);

  // ─── POST /FederationSync skips a skill-tagged row ────────────────────────

  test("GUARD: POST /FederationSync skips a skill-tagged Memory (skill_not_federated)", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "skill-fed-spoke";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");
    await seed("Peer", [{ id: instanceId, publicKey: publicKeyB64url, role: "spoke", status: "paired", createdAt: now }]);

    const signed = signBodyFresh({
      instanceId,
      records: [
        {
          table: "Memory",
          id: "skill-fed-1",
          data: { id: "skill-fed-1", agentId: owner.id, content: "procedure", tags: ["skill"], trigger: "when to use", createdAt: now },
          updatedAt: new Date().toISOString(),
        },
      ],
      lamportClock: Date.now(),
    }, kp.secretKey);

    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(0);
    expect(body.skippedReasons?.skill_not_federated).toBe(1);
    // The skill-tagged row never landed in the table.
    expect(await readMemory("skill-fed-1")).toBeUndefined();
  }, 30_000);

  test("POSITIVE CONTROL: POST /FederationSync still merges a non-skill Memory", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "skill-fed-spoke-ok";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");
    await seed("Peer", [{ id: instanceId, publicKey: publicKeyB64url, role: "spoke", status: "paired", createdAt: now }]);

    const signed = signBodyFresh({
      instanceId,
      records: [
        {
          table: "Memory",
          id: "skill-fed-ok-1",
          data: { id: "skill-fed-ok-1", agentId: owner.id, content: "a normal memory", createdAt: now },
          updatedAt: new Date().toISOString(),
        },
      ],
      lamportClock: Date.now(),
    }, kp.secretKey);

    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(1);
    expect(await readMemory("skill-fed-ok-1")).not.toBeUndefined();
  }, 30_000);

  // ─── POST /AgentSeed rejects a skill-tagged starter memory ────────────────

  test("GUARD: POST /AgentSeed rejects a skill-tagged starter memory (400 skill_write_path)", async () => {
    const res = await operator("POST", "/AgentSeed", {
      agentId: "skill-seed-agent",
      starterMemories: [{ content: "procedure", tags: ["skill"], trigger: "when to use" }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("skill_write_path");
  }, 30_000);
});
