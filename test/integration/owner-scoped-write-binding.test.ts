// owner-scoped-write-binding.test.ts — against a real Harper: a verified
// non-admin agent's addressed POST, PUT or PATCH to an owner-scoped table whose
// body names a record other than the addressed one is refused with a named
// refusal, for each body id shape below.
//
// The tables come from OWNER_FIELDS (resources/record-owner-guard.ts), the
// owner-scoped write guard's table list. A table added there fails the coverage
// check at the end until it has a spec here or a stated reason it has no
// table-backed route.
//
// Each refused case reads the table's full stored contents as the operator
// before and after the request and asserts they are equal, then asserts the
// refusal's status and body.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { OWNER_FIELDS } from "../../resources/record-owner-guard.js";
import { ownerScopedInventory, resourceClasses } from "../helpers/owner-scoped-resource-inventory";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(a: TestAgent, method: string, path: string): string {
  const u = new URL(path, "http://localhost");
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${a.id}:${ts}:${nonce}:${method}:${u.pathname}${u.search}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), a.secretKey);
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
const owner = mkAgent("osb-owner");
const caller = mkAgent("osb-caller");
const NOW = new Date().toISOString();
const e = encodeURIComponent;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

async function adminOp(op: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function seed(table: string, rec: Record<string, unknown>): Promise<void> {
  const r = await adminOp({ operation: "upsert", database: "flair", table, records: [rec] });
  expect(r.status, `seed ${table} returned ${r.status}: ${await r.clone().text()}`).toBe(200);
}

/** Every stored row of `table`, read as the operator and ordered by key. */
async function tableContents(table: string, pk: string): Promise<Array<[string, unknown]>> {
  const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: pk, search_value: "*", get_attributes: ["*"] });
  expect(res.status, `reading ${table} returned ${res.status}`).toBe(200);
  const rows = await res.json() as Array<Record<string, unknown>>;
  return rows.map((row) => [JSON.stringify(row[pk]), row] as [string, unknown]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function send(a: TestAgent, method: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(a, method, path) },
    body: JSON.stringify(body),
  });
}

/** One owner-scoped table reachable over REST: a valid row, the field a write changes, and its ids. */
interface TableSpec {
  pk: string;
  mut: string;
  /** The owner can PATCH an ordinary field of its own row (false for tables whose own rule refuses it). */
  ownerPatchable: boolean;
  idFor: (n: string, ownerId: string) => string;
  row: (id: string, ownerId: string) => Record<string, unknown>;
}

const SPECS: Record<string, TableSpec> = {
  Memory: { pk: "id", mut: "content", ownerPatchable: true, idFor: (n) => `osb-mem-${n}`,
    row: (id, o) => ({ id, agentId: o, content: "orig", durability: "persistent", visibility: "shared", createdAt: NOW, updatedAt: NOW }) },
  Relationship: { pk: "id", mut: "object", ownerPatchable: true, idFor: (n) => `osb-rel-${n}`,
    row: (id, o) => ({ id, agentId: o, subject: "s", predicate: "p", object: "orig", createdAt: NOW }) },
  Soul: { pk: "id", mut: "value", ownerPatchable: false, idFor: (n, o) => `${o}:osb-k${n}`,
    row: (id, o) => ({ id, agentId: o, key: id.slice(id.indexOf(":") + 1), value: "orig", durability: "permanent", createdAt: NOW, updatedAt: NOW }) },
  Credential: { pk: "id", mut: "status", ownerPatchable: true, idFor: (n) => `osb-cred-${n}`,
    row: (id, o) => ({ id, principalId: o, kind: "bearer-token", status: "active", createdAt: NOW }) },
  Integration: { pk: "id", mut: "username", ownerPatchable: true, idFor: (n) => `osb-integ-${n}`,
    row: (id, o) => ({ id, agentId: o, platform: "slack", username: "orig", createdAt: NOW }) },
  Asset: { pk: "id", mut: "memoryId", ownerPatchable: true, idFor: (n) => `osb-asset-${n}`,
    row: (id, o) => ({ id, agentId: o, memoryId: "orig", contentType: "image/png", createdAt: NOW }) },
  MemoryCandidate: { pk: "id", mut: "claim", ownerPatchable: true, idFor: (n) => `osb-cand-${n}`,
    row: (id, o) => ({ id, agentId: o, claim: "orig", generatedAt: NOW, status: "pending", createdAt: NOW }) },
  MemoryGrant: { pk: "id", mut: "scope", ownerPatchable: true, idFor: (n) => `osb-grant-${n}`,
    row: (id, o) => ({ id, ownerId: o, granteeId: o, scope: "orig", createdAt: NOW }) },
  MemoryUsage: { pk: "id", mut: "attribution", ownerPatchable: false, idFor: (n, o) => `${o}:osb-use${n}`,
    row: (id, o) => ({ id, agentId: o, memoryId: id.slice(id.indexOf(":") + 1), attribution: "orig", createdAt: NOW }) },
  Message: { pk: "id", mut: "body", ownerPatchable: false, idFor: (n) => `osb-msg-${n}`,
    row: (id, o) => ({ id, from: o, to: "osb-recipient", kind: "text", body: "orig", state: "pending", createdAt: NOW }) },
  OrgEvent: { pk: "id", mut: "summary", ownerPatchable: true, idFor: (n) => `osb-oe-${n}`,
    row: (id, o) => ({ id, authorId: o, kind: "k", summary: "orig", createdAt: NOW }) },
  WorkspaceState: { pk: "id", mut: "ref", ownerPatchable: true, idFor: (n) => `osb-ws-${n}`,
    row: (id, o) => ({ id, agentId: o, ref: "orig", provider: "git", timestamp: NOW, createdAt: NOW }) },
  // Presence is keyed by its owner field: the caller's own row is keyed by caller.id.
  Presence: { pk: "agentId", mut: "activity", ownerPatchable: true, idFor: (n) => `osb-presence-${n}`,
    row: (id) => ({ agentId: id, lastHeartbeatAt: Date.now(), activity: "orig" }) },
};

/** OWNER_FIELDS tables with no table-backed REST route, and why. */
const NO_ROUTE: Record<string, string> = {
  AgentReadPosition: "served by a custom Resource at /AgentReadPosition that applies its own owner rule; not table-backed",
  OAuthAuthCode: "no REST route; written by the OAuth flow in-process",
  OAuthToken: "no table-backed REST route; /OAuthToken is the OAuth token endpoint (resources/OAuth.ts)",
};

const ownerIsKey = (table: string) => OWNER_FIELDS[table] === SPECS[table]?.pk;

const NOT_ADDRESSED = { status: 403, body: { error: "write_id_not_addressed", message: "a write may name only the record it addresses" } };
const MISMATCH = { status: 400, body: { error: "id_target_mismatch", message: "the request body id does not match the address it was sent to" } };

interface Fixture {
  /** Another principal's record under a string key. */
  otherId: string;
  /** Another principal's record under a composite key; seeded where the key is not the owner field. */
  otherCompositeId: string[];
  /** The caller's own record. */
  mineId: string;
  /** A key with no stored record. */
  freshId: string;
  n: string;
}

async function fixture(table: string): Promise<Fixture> {
  const s = SPECS[table];
  const n = randomUUID().slice(0, 8);
  const otherId = s.idFor(`o-${n}`, owner.id);
  await seed(table, s.row(otherId, ownerIsKey(table) ? otherId : owner.id));
  const otherCompositeId = ["osb-composite", n];
  if (!ownerIsKey(table)) await seed(table, { ...s.row(s.idFor(`c-${n}`, owner.id), owner.id), [s.pk]: otherCompositeId });
  const mineId = ownerIsKey(table) ? caller.id : s.idFor(`m-${n}`, caller.id);
  await seed(table, s.row(mineId, caller.id));
  const freshId = s.idFor(`f-${n}`, caller.id);
  return { otherId, otherCompositeId, mineId, freshId, n };
}

interface Shape {
  label: string;
  want: typeof NOT_ADDRESSED;
  /** The id the body names. */
  id: (f: Fixture) => unknown;
  /** Send the record as the one element of an array body. */
  arrayBody?: boolean;
  /** Only for tables whose key is not the owner field (the shape needs a composite-key record of another principal). */
  needsCompositeRecord?: boolean;
}

const SHAPES: Shape[] = [
  { label: "a string body id naming another principal's record", want: NOT_ADDRESSED, id: (f) => f.otherId },
  { label: "a one-element array body id naming another principal's record", want: MISMATCH, id: (f) => [f.otherId] },
  { label: "a composite body id naming another principal's record", want: MISMATCH, id: (f) => f.otherCompositeId, needsCompositeRecord: true },
  { label: "a composite body id naming no stored record", want: MISMATCH, id: (f) => ["osb-unstored", f.n] },
  { label: "an array body whose record names another principal's record", want: NOT_ADDRESSED, id: (f) => f.otherId, arrayBody: true },
];

describe("the owner-scoped guard checks a non-admin addressed write's body id for every id type", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
    for (const a of [owner, caller]) {
      await seed("Agent", { id: a.id, name: a.id, role: "agent", admin: false, publicKey: a.publicKey, createdAt: NOW });
    }
  }, 240_000);

  afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

  // A table with no spec is reported by the coverage check below.
  for (const table of Object.keys(OWNER_FIELDS).filter((t) => t in SPECS)) {
    const s = SPECS[table];
    // A table keyed by its owner field has no address the caller may write other than its own record.
    const addresses = ownerIsKey(table) ? (["mine"] as const) : (["mine", "fresh"] as const);
    const shapes = SHAPES.filter((shape) => !shape.needsCompositeRecord || !ownerIsKey(table));
    describe(table, () => {
      for (const address of addresses) {
        for (const shape of shapes) {
          for (const verb of ["POST", "PUT", "PATCH"] as const) {
            test(`${table}: a ${verb} addressed to ${address === "mine" ? "the caller's record" : "a fresh id"} with ${shape.label} is refused and changes no row`, async () => {
              const f = await fixture(table);
              const named = shape.id(f);
              const addressed = address === "mine" ? f.mineId : f.freshId;
              const record: Record<string, unknown> = { ...s.row(addressed, caller.id), [s.mut]: "named-via-body" };
              record.id = named;
              const body = shape.arrayBody ? [record] : record;
              const before = await tableContents(table, s.pk);

              const res = await send(caller, verb, `/${table}/${e(addressed)}`, body);
              const text = await res.text();

              expect(await tableContents(table, s.pk), `${table} ${verb}: the refused write changed a stored row`).toEqual(before);
              expect({ status: res.status, body: JSON.parse(text) }, `${table} ${verb} answered ${res.status}: ${text.slice(0, 200)}`).toEqual(shape.want);
            }, 30_000);
          }
        }
      }

      if (s.ownerPatchable) {
        test(`${table}: the caller's PATCH to its own record with a matching body id writes that record and no other`, async () => {
          const f = await fixture(table);
          const before = new Map(await tableContents(table, s.pk));
          const res = await send(caller, "PATCH", `/${table}/${e(f.mineId)}`, { id: f.mineId, [s.mut]: "matching-id" });
          expect(res.status, `${table} PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
          const after = new Map(await tableContents(table, s.pk));
          const mineKey = JSON.stringify(f.mineId);
          expect((after.get(mineKey) as Record<string, unknown> | undefined)?.[s.mut], `${table}: the caller's record was not written`).toBe("matching-id");
          after.delete(mineKey);
          before.delete(mineKey);
          expect(after, `${table}: a record other than the addressed one changed`).toEqual(before);
        }, 30_000);
      }
    });
  }

  test("OrgEvent: the caller's PUT and addressed POST with a matching body id write the addressed record", async () => {
    for (const verb of ["PUT", "POST"] as const) {
      const id = `osb-oe-match-${verb.toLowerCase()}-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, verb, `/OrgEvent/${e(id)}`, { id, authorId: caller.id, kind: "k", summary: `matching-${verb}` });
      expect(res.status, `OrgEvent ${verb} returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      const rows = (await tableContents("OrgEvent", "id")).map(([, row]) => row as Record<string, unknown>).filter((row) => row.summary === `matching-${verb}`);
      expect(rows.map((row) => [row.id, row.authorId]), `OrgEvent ${verb} wrote a record other than the addressed one`).toEqual([[id, caller.id]]);
    }
  }, 30_000);

  test("every OWNER_FIELDS table has a spec or a stated no-route reason", () => {
    const unaccounted = Object.keys(OWNER_FIELDS).filter((t) => !(t in SPECS) && !(t in NO_ROUTE));
    expect(unaccounted, "OWNER_FIELDS tables with neither a spec nor a stated reason").toEqual([]);
    expect(Object.keys(NO_ROUTE).filter((t) => t in SPECS), "a table is both specced and excepted").toEqual([]);
    expect(Object.keys(SPECS).filter((t) => !(t in OWNER_FIELDS)), "a spec names a table outside OWNER_FIELDS").toEqual([]);
  });

  test("the resource classes that extend owner-scoped tables all have specs", () => {
    const inventory = ownerScopedInventory(resourceClasses(join(import.meta.dir, "..", "..", "resources")), Object.keys(OWNER_FIELDS));
    expect(inventory.tableExtending.filter((t) => !(t in SPECS)), "table-extending owner-scoped resource classes without a spec").toEqual([]);
    expect(inventory.customRoutes.map((c) => c.className).filter((n) => !(n in NO_ROUTE)), "custom routes at an owner-scoped name without a stated reason").toEqual([]);
  });
});
