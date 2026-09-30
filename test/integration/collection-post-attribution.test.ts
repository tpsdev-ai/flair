// A collection POST never stores an owner or attribution taken from the body.
//
// For every table in the flair database, a verified non-admin agent's POST to
// the collection route `/<Table>/` either is refused and creates no row, or
// creates a row whose owner is the caller and whose `originatorInstanceId` and
// `provenance` (where the table declares them) are the server's values, never
// the body's. A table whose resource defines no post() of its own refuses a
// non-admin collection POST (resources/table-post-policy.ts); Relationship's
// post() applies the same preparation as its put().
//
// Every case runs on two Harpers, one per `authentication.authorizeLocal`
// setting (on, the harness default; and off), and on each Harper twice: before
// the least-privilege `flair-agent` Harper user is provisioned and after.
//   (a) ENUMERATION — every table, read from the database at runtime, with a
//       body built from the table's declared attributes: owner fields naming
//       another agent, then the caller; a body-supplied `originatorInstanceId`
//       and `provenance` in both.
//   (b) Relationship: a collection POST is created with the caller as owner and
//       server-side `originatorInstanceId` and `provenance`; a body naming
//       another agent is refused; an existing id is refused; an anonymous
//       caller is refused.
//   (c) The write routes of the four tables whose rows carry
//       `originatorInstanceId` (Memory, Relationship, Soul, Agent): a
//       collection POST, a PUT to a new id and an update of an existing row
//       each store this instance's own id, never the body's value.
//   (d) An administrator's collection POST on a table whose resource defines no
//       post() still creates the row.
//
// Mutation check: remove Relationship's post() and the table POST guard — (a)
// and (b) go red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { OWNER_FIELDS } from "../../resources/record-owner-guard";

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
 * the OS-assigned ports it was started on, never a production port, and a data
 * directory under the temp dir.
 */
function assertOwnInstance(harper: HarperInstance): void {
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
}

const A = mkAgent("tpost-a"); // another agent
const B = mkAgent("tpost-b"); // the verified non-admin caller
const BODY_ORIGIN = "body-supplied-origin";
const BODY_TS = "2001-01-01T00:00:00.000Z";
const OWNER_SHAPED = ["agentId", "authorId", "principalId", "ownerId", "from"];

const HARPERS = [
  { name: "authorizeLocal on (harness default)", authorizeLocal: undefined },
  { name: "authorizeLocal off", authorizeLocal: "false" },
] as const;

function bodyProvenance(owner: string): Record<string, unknown> {
  return { v: 1, verified: { agentId: owner, timestamp: BODY_TS, receivedAt: BODY_TS } };
}

for (const config of HARPERS) {
  describe(`a collection POST stores no body-supplied owner or attribution — ${config.name}`, () => {
    let harper: HarperInstance;
    const tag = config.authorizeLocal ?? "default";
    // This instance's own federation identity: the one Instance row, seeded in
    // beforeAll, is the value a server-side create stamps.
    const LOCAL_INSTANCE = `tpost-local-${tag}`;
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

    async function send(method: string, path: string, body: unknown, auth: TestAgent | "basic" | null) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (auth === "basic") headers.Authorization = basic();
      else if (auth) headers.Authorization = ed25519Header(auth, method, path);
      const res = await fetch(`${harper.httpURL}${path}`, { method, headers, body: JSON.stringify(body) });
      return { status: res.status, text: (await res.text()).slice(0, 300) };
    }

    /** A body that is valid for `table`'s declared attributes, with the given owner and body-supplied attribution. */
    function bodyFor(attributes: any[], id: string, owner: string): Record<string, unknown> {
      const now = new Date().toISOString();
      const body: Record<string, unknown> = {};
      for (const a of attributes) {
        const name = String(a.attribute);
        const type = String(a.type ?? "String");
        if (name === "id") body.id = id;
        else if (name === "originatorInstanceId") body[name] = BODY_ORIGIN;
        else if (name === "provenance") body[name] = type === "String" ? JSON.stringify(bodyProvenance(owner)) : bodyProvenance(owner);
        else if (OWNER_SHAPED.includes(name)) body[name] = owner;
        else if (name === "createdAt" || name === "updatedAt") body[name] = now;
        else if (/^(Int|Long|Float|Number)$/.test(type)) body[name] = 1;
        else if (type === "Boolean") body[name] = false;
        else if (type === "String" || type === "ID") body[name] = `${name}-${id}`;
      }
      if (!("id" in body)) body.id = id;
      return body;
    }

    /** What is wrong with a stored row, or null: owner not the caller, or body-supplied attribution kept. */
    function attributionProblems(table: string, row: any, declared: Set<string>): string[] {
      const problems: string[] = [];
      const ownerField = OWNER_FIELDS[table];
      if (ownerField && row[ownerField] !== B.id) problems.push(`${ownerField}=${JSON.stringify(row[ownerField])}`);
      if (declared.has("originatorInstanceId") && row.originatorInstanceId !== LOCAL_INSTANCE) problems.push(`originatorInstanceId=${JSON.stringify(row.originatorInstanceId)}`);
      if (declared.has("provenance") && JSON.stringify(row.provenance ?? null).includes(BODY_TS)) problems.push("provenance from the body");
      return problems;
    }

    function cases(phase: string) {
      const p = `tpost-${tag}-${phase}`;

      test("(a) every table in the database: a non-admin collection POST stores no body-supplied owner or attribution", async () => {
        const described = await adminOp({ operation: "describe_database", database: "flair" });
        const tables = Object.keys(described).sort();
        for (const t of ["Relationship", "Memory", "Soul", "Agent"]) expect(tables, `${t} is a table`).toContain(t);
        const found: string[] = [];
        for (const t of tables) {
          const attributes = described[t].attributes ?? [];
          const declared = new Set<string>(attributes.map((a: any) => String(a.attribute)));
          for (const [label, owner] of [["another agent as owner", A.id], ["own owner", B.id]] as const) {
            const id = `${p}-${t}-${randomUUID()}`;
            const r = await send("POST", `/${t}/`, bodyFor(attributes, id, owner), B);
            const row = await rowIn(t, id);
            if (!row) continue; // refused, or no row under this id
            const problems = attributionProblems(t, row, declared);
            if (problems.length > 0) found.push(`${t} (${label}): POST ${r.status} stored ${problems.join(", ")}`);
          }
        }
        expect(found, `tables: ${tables.join(", ")}`).toEqual([]);
      }, 120_000);

      test("(b) Relationship: a collection POST is created with the caller as owner and server-side attribution", async () => {
        const now = new Date().toISOString();
        const id = `${p}-rel-${randomUUID()}`;
        const created = await send("POST", "/Relationship/", {
          id, agentId: B.id, subject: "Flair", predicate: "Uses", object: "Harper", createdAt: now,
          originatorInstanceId: BODY_ORIGIN, provenance: JSON.stringify(bodyProvenance(B.id)),
        }, B);
        expect(created.status, created.text).toBeLessThan(300);
        const row = await rowIn("Relationship", id);
        expect(row?.agentId).toBe(B.id);
        expect(row?.originatorInstanceId).toBe(LOCAL_INSTANCE);
        const provenance = JSON.parse(String(row?.provenance));
        expect(provenance?.verified?.agentId).toBe(B.id);
        expect(provenance?.verified?.timestamp).not.toBe(BODY_TS);
        expect(row?.subject).toBe("flair"); // normalized as put() does

        const unowned = `${p}-rel-${randomUUID()}`;
        const stamped = await send("POST", "/Relationship/", { id: unowned, subject: "a", predicate: "b", object: "c", createdAt: now }, B);
        expect(stamped.status, stamped.text).toBeLessThan(300);
        expect((await rowIn("Relationship", unowned))?.agentId, "an absent owner is stamped with the caller").toBe(B.id);

        const otherOwnerId = `${p}-rel-${randomUUID()}`;
        const otherOwner = await send("POST", "/Relationship/", { id: otherOwnerId, agentId: A.id, subject: "a", predicate: "b", object: "c", createdAt: now }, B);
        expect(otherOwner.status, otherOwner.text).toBe(403);
        expect(await rowIn("Relationship", otherOwnerId)).toBeNull();

        const again = await send("POST", "/Relationship/", { id, agentId: B.id, subject: "x", predicate: "y", object: "z", createdAt: now }, B);
        expect(again.status, `an existing id: ${again.text}`).toBe(409);
        expect((await rowIn("Relationship", id))?.subject, "the existing row is unchanged").toBe("flair");

        const anonId = `${p}-rel-${randomUUID()}`;
        const anonymous = await send("POST", "/Relationship/", { id: anonId, agentId: B.id, subject: "a", predicate: "b", object: "c", createdAt: now }, null);
        expect(anonymous.status, anonymous.text).toBeGreaterThanOrEqual(400);
        expect(await rowIn("Relationship", anonId)).toBeNull();
      }, 60_000);

      test("(c) the write routes of Memory, Relationship, Soul and Agent store the server's originatorInstanceId", async () => {
        const check = async (label: string, table: string, method: string, path: string, body: Record<string, unknown>, auth: TestAgent | "basic", id: string) => {
          const r = await send(method, path, { ...body, originatorInstanceId: BODY_ORIGIN }, auth);
          expect(r.status, `${label}: ${r.text}`).toBeLessThan(300);
          const row = await rowIn(table, id);
          expect(row, `${label}: row stored`).not.toBeNull();
          expect(row.originatorInstanceId, `${label}: originatorInstanceId`).toBe(LOCAL_INSTANCE);
        };
        const now = new Date().toISOString();
        // A collection POST creates; a PUT to a new id creates; a PUT to the
        // POST-created id updates.
        const m1 = `${p}-mem-${randomUUID()}`;
        const m2 = `${p}-mem-${randomUUID()}`;
        await check("Memory POST", "Memory", "POST", "/Memory/", { id: m1, agentId: B.id, content: `${m1} content` }, B, m1);
        await check("Memory PUT (create)", "Memory", "PUT", `/Memory/${m2}`, { id: m2, agentId: B.id, content: `${m2} content` }, B, m2);
        await check("Memory PUT (update)", "Memory", "PUT", `/Memory/${m1}`, { id: m1, agentId: B.id, content: `${m1} updated` }, B, m1);
        const r1 = `${p}-rel-${randomUUID()}`;
        const r2 = `${p}-rel-${randomUUID()}`;
        await check("Relationship POST", "Relationship", "POST", "/Relationship/", { id: r1, agentId: B.id, subject: "a", predicate: "b", object: "c", createdAt: now }, B, r1);
        await check("Relationship PUT (create)", "Relationship", "PUT", `/Relationship/${r2}`, { id: r2, agentId: B.id, subject: "a", predicate: "b", object: "c" }, B, r2);
        await check("Relationship PUT (update)", "Relationship", "PUT", `/Relationship/${r1}`, { id: r1, agentId: B.id, subject: "a", predicate: "b", object: "d" }, B, r1);
        const s1 = `${B.id}:${p}-post`;
        const s2 = `${B.id}:${p}-put`;
        await check("Soul POST", "Soul", "POST", "/Soul/", { id: s1, agentId: B.id, key: `${p}-post`, value: "v", createdAt: now }, "basic", s1);
        await check("Soul PUT (create)", "Soul", "PUT", `/Soul/${encodeURIComponent(s2)}`, { id: s2, agentId: B.id, key: `${p}-put`, value: "v", createdAt: now }, "basic", s2);
        await check("Soul PUT (update)", "Soul", "PUT", `/Soul/${encodeURIComponent(s1)}`, { id: s1, agentId: B.id, key: `${p}-post`, value: "w", createdAt: now }, "basic", s1);
        // An Agent row is created by POST (its publicKey is set only at create;
        // put() and patch() drop a body publicKey) and updated by PATCH.
        const a1 = `${p}-agent-post`;
        await check("Agent POST", "Agent", "POST", "/Agent/", { id: a1, name: a1, role: "agent", publicKey: mkAgent(a1).publicKey, createdAt: now }, "basic", a1);
        await check("Agent PATCH (update)", "Agent", "PATCH", `/Agent/${a1}`, { name: `${a1}-renamed` }, "basic", a1);
      }, 60_000);

      test("(d) an administrator's collection POST on a table whose resource defines no post() still creates the row", async () => {
        const described = await adminOp({ operation: "describe_database", database: "flair" });
        const id = `${p}-peer-${randomUUID()}`;
        const r = await send("POST", "/Peer/", bodyFor(described.Peer.attributes ?? [], id, B.id), "basic");
        expect(r.status, r.text).toBeLessThan(300);
        expect(await rowIn("Peer", id), "row created").not.toBeNull();
      }, 60_000);
    }

    beforeAll(async () => {
      const prior = process.env.AUTHENTICATION_AUTHORIZELOCAL;
      if (config.authorizeLocal === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
      else process.env.AUTHENTICATION_AUTHORIZELOCAL = config.authorizeLocal;
      try {
        harper = await startHarper();
        assertOwnInstance(harper);
      } finally {
        if (prior === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
        else process.env.AUTHENTICATION_AUTHORIZELOCAL = prior;
      }
      const now = new Date().toISOString();
      await adminOp({ operation: "upsert", database: "flair", table: "Instance", records: [{ id: LOCAL_INSTANCE, publicKey: "tpost-instance-key", role: "hub", status: "active", createdAt: now }] });
      for (const ag of [A, B]) {
        await adminOp({ operation: "upsert", database: "flair", table: "Agent", records: [{ id: ag.id, name: ag.id, role: "agent", publicKey: ag.publicKey, createdAt: now }] });
      }
    }, 180_000);

    afterAll(async () => {
      if (harper) await stopHarper(harper);
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
