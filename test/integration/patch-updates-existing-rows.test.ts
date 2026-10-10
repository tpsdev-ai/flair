// PATCH updates existing rows; for a caller that is neither an administrator
// nor a trusted internal call it never creates one.
//
// For every table in the flair database, a PATCH whose target row does not
// exist does not create or modify its target row unless the caller is an
// administrator or a trusted internal call: a verified non-admin agent and an
// anonymous caller are refused (404 from the table's guard, or an earlier
// refusal from Harper's permission check or routing, or from the resource) and
// no row appears. A
// PATCH to the caller's own existing row still updates it, and an
// administrator's PATCH behaves as before.
//
// Every case runs on two Harpers, one per `authentication.authorizeLocal`
// setting (on, the harness default; and off). Each (a)–(d) case runs in both
// provisioning phases; calibration runs once per Harper. The phases are before
// the least-privilege `flair-agent` Harper user is provisioned (verified agents
// then resolve to the shared admin Harper user) and after.
//   (a) ENUMERATION — every table in the flair database, read from the database
//       itself at runtime: a non-admin PATCH to a missing id is refused and no
//       row is created. A table added later is enumerated, and so checked,
//       without being named.
//   (b) Memory: a PATCH to a missing id is refused whether the body names
//       another agent, the caller itself, a null owner or no owner; anonymous
//       too.
//   (c) The caller's own existing rows (a Memory row, and its own Agent record)
//       still update through PATCH.
//   (d) An administrator (Basic and an admin agent) still creates and updates
//       rows through PATCH.
//
// Mutation check: remove the table PATCH guard — every table that would create
// the row goes red in (a), and (b) goes red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/**
 * Refuse to talk to anything but this test's own ephemeral instance: loopback,
 * the OS-assigned ports this instance was started on, never a production port,
 * and a data directory under the temp dir.
 */
function assertOwnInstance(harper: HarperInstance): { httpPort: number; opsPort: number } {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  const httpPort = Number(http.port);
  const opsPort = Number(ops.port);
  for (const [label, u, port] of [["http", http, httpPort], ["ops", ops, opsPort]] as const) {
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (httpPort === opsPort || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
  return { httpPort, opsPort };
}

const A = mkAgent("tpatch-a"); // another agent
const B = mkAgent("tpatch-b"); // the verified non-admin caller
const ADMIN = mkAgent("tpatch-admin"); // an admin agent (role "admin")

const HARPERS = [
  { name: "authorizeLocal on (harness default)", authorizeLocal: undefined, anonymousGetStatus: 403 },
  { name: "authorizeLocal off", authorizeLocal: "false", anonymousGetStatus: 401 },
] as const;

/**
 * A body that would make a valid row in as many tables as possible: the caller
 * as every owner-shaped field, plus the other commonly required columns.
 */
function createBody(id: string, owner: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    agentId: owner, authorId: owner, principalId: owner, ownerId: owner, from: owner, granteeId: owner,
    to: owner, memoryId: `${id}-memory`, content: `${id} content`, summary: `${id} summary`, kind: "note",
    key: "k", value: "v", name: id, publicKey: `${id}-key`, status: "active", role: "agent",
    subject: owner, predicate: "knows", object: owner, stream: "org-event", position: 1,
    createdAt: now, updatedAt: now, timestamp: now,
  };
}

for (const config of HARPERS) {
  describe(`PATCH updates existing rows only — ${config.name}`, () => {
    let harper: HarperInstance;
    const tag = config.authorizeLocal ?? "default";
    const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

    async function adminOp(op: Record<string, any>): Promise<any> {
      const res = await fetch(harper.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basic() },
        body: JSON.stringify(op),
      });
      const text = await res.text();
      expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
      return JSON.parse(text);
    }

    async function rowIn(table: string, id: string): Promise<any | null> {
      const rows = await adminOp({ operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: ["*"] });
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }

    async function patch(path: string, body: unknown, auth: TestAgent | "basic" | null): Promise<{ status: number; text: string }> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (auth === "basic") headers.Authorization = basic();
      else if (auth) headers.Authorization = ed25519Header(auth, "PATCH", path);
      const res = await fetch(`${harper.httpURL}${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
      return { status: res.status, text: (await res.text()).slice(0, 300) };
    }

    async function writeOwnMemory(agent: TestAgent, id: string, content: string): Promise<void> {
      const path = "/FeedMemories";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
        body: JSON.stringify({ id, agentId: agent.id, content, visibility: "private" }),
      });
      const text = await res.text();
      expect(res.status, `memory write ${id} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    }

    function cases(phase: string) {
      const p = `tpatch-${tag}-${phase}`;

      test("(a) every table in the database: a non-admin PATCH to a missing id is not reported as a success and creates no row", async () => {
        const described = await adminOp({ operation: "describe_database", database: "flair" });
        const tables = Object.keys(described).sort();
        // Not vacuous: the enumeration reaches the tables this rule exists for.
        for (const t of ["Memory", "Message", "MemoryUsage", "Soul", "Agent"]) expect(tables, `${t} is a table`).toContain(t);
        const found: string[] = [];
        for (const t of tables) {
          // The owner fields name the caller, then another agent.
          for (const [label, owner] of [["own owner", B.id], ["another agent as owner", A.id]] as const) {
            const id = `${p}-${t}-${randomUUID()}`;
            const r = await patch(`/${t}/${encodeURIComponent(id)}`, createBody(id, owner), B);
            const row = await rowIn(t, id);
            if (row) found.push(`${t} (${label}): PATCH ${r.status} created the row`);
            else if (r.status >= 200 && r.status < 300) found.push(`${t} (${label}): PATCH ${r.status} reported success for a row that does not exist`);
          }
        }
        expect(found, `tables: ${tables.join(", ")}`).toEqual([]);
      }, 120_000);

      test("(b) Memory: a PATCH to a missing id is refused whatever owner the body names, and for an anonymous caller", async () => {
        const variants: Array<[string, Record<string, unknown>, TestAgent | null]> = [
          ["another agent's id", { agentId: A.id }, B],
          ["the caller's own id", { agentId: B.id }, B],
          ["a null owner", { agentId: null }, B],
          ["no owner", {}, B],
          ["an anonymous caller", { agentId: A.id }, null],
        ];
        for (const [label, owner, caller] of variants) {
          const id = `${p}-memory-${randomUUID()}`;
          const r = await patch(`/Memory/${id}`, { content: `${p} ${label}`, ...owner }, caller);
          expect(r.status, `${label}: ${r.text}`).toBeGreaterThanOrEqual(400);
          if (caller) {
            expect(r.status, `${label}: ${r.text}`).toBe(404);
            expect(r.text, label).toContain("PATCH updates an existing Memory row");
          }
          expect(await rowIn("Memory", id), `${label}: no row`).toBeNull();
        }
      }, 60_000);

      test("(c) the caller's own existing rows still update through PATCH", async () => {
        const id = `${p}-own-memory`;
        await writeOwnMemory(B, id, `${p} own v1`);
        const r = await patch(`/Memory/${id}`, { content: `${p} own v2` }, B);
        expect(r.status, r.text).toBeLessThan(300);
        expect((await rowIn("Memory", id))?.content).toBe(`${p} own v2`);

        const displayName = `${p} display`;
        const self = await patch(`/Agent/${B.id}`, { displayName }, B);
        expect(self.status, self.text).toBeLessThan(300);
        expect((await rowIn("Agent", B.id))?.displayName).toBe(displayName);
      }, 60_000);

      test("(d) an administrator still creates and updates rows through PATCH (Basic and an admin agent)", async () => {
        for (const [label, auth] of [["Basic", "basic"], ["admin agent", ADMIN]] as const) {
          const id = `${p}-admin-${randomUUID()}`;
          // Lower case: Memory writes redact `Basic <text>` as a credential (flair#2407).
          const text = label.toLowerCase();
          const created = await patch(`/Memory/${id}`, { agentId: A.id, content: `${p} ${text} create` }, auth);
          expect(created.status, `${label} create: ${created.text}`).toBeLessThan(300);
          expect((await rowIn("Memory", id))?.content, `${label} create`).toBe(`${p} ${text} create`);
          const updated = await patch(`/Memory/${id}`, { content: `${p} ${text} update` }, auth);
          expect(updated.status, `${label} update: ${updated.text}`).toBeLessThan(300);
          expect((await rowIn("Memory", id))?.content, `${label} update`).toBe(`${p} ${text} update`);
        }
      }, 60_000);
    }

    beforeAll(async () => {
      // startHarper copies process.env into the spawned Harper's environment;
      // restore it immediately so no other file sees the override.
      const prior = process.env.AUTHENTICATION_AUTHORIZELOCAL;
      if (config.authorizeLocal === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
      else process.env.AUTHENTICATION_AUTHORIZELOCAL = config.authorizeLocal;
      try {
        harper = await startHarper();
      } finally {
        if (prior === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
        else process.env.AUTHENTICATION_AUTHORIZELOCAL = prior;
      }
      assertOwnInstance(harper);
      const now = new Date().toISOString();
      for (const [ag, role] of [[A, "agent"], [B, "agent"], [ADMIN, "admin"]] as const) {
        await adminOp({ operation: "upsert", database: "flair", table: "Agent", records: [{ id: ag.id, name: ag.id, role, publicKey: ag.publicKey, createdAt: now }] });
      }
    }, 180_000);

    afterAll(async () => {
      if (harper) await stopHarper(harper);
    }, 30_000);

    test(`the Harper under test runs with ${config.name}`, async () => {
      const id = `tpatch-calibration-${tag}`;
      await writeOwnMemory(A, id, "calibration");
      const res = await fetch(`${harper.httpURL}/Memory/${id}`);
      await res.arrayBuffer();
      expect(res.status).toBe(config.anonymousGetStatus);
    }, 30_000);

    describe("agents resolve to the shared admin Harper user", () => {
      cases("shared-user");
    });

    describe("agents resolve to the least-privilege flair-agent user", () => {
      beforeAll(async () => {
        await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
        await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
      }, 60_000);

      cases("flair-agent");
    });
  });
}
