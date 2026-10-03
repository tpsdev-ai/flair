// ─── flair#2222 — a concurrent change between preflight and write refuses ────
//
// Re-read Agent presence and canonicalized fields of principal-bearing IdP rows
// before each write. Valid comparison differences refuse with mapping-changed-underneath;
// invalid changed rows can fail earlier validation with missing-or-invalid-credential-field.
// Both fail closed.
//
// Every command talks only to this test's own ephemeral instance: the numeric
// ops port it was started on, checked before the first call.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import {
  linkPrincipalMapping,
  unlinkPrincipalMapping,
  provisionIdpIdentityMapping,
} from "../../src/lib/mcp-enable";

const sfx = Date.now().toString(36);
const SUBJECT = "octocat";
const PROVIDER = "github";
const PRINCIPAL = `race-alice-${sfx}`;
const OTHER = `race-bob-${sfx}`;
const THIRD = `race-carl-${sfx}`;

let harper: HarperInstance;
let opsPort: number;

function basicHeader(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

/** One raw ops call against THIS instance. */
async function adminOp(op: Record<string, any>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader() },
    body: JSON.stringify(op),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`admin ${op.operation} ${op.table} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** The subject's Credential rows, read straight from storage. */
async function subjectCreds(): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_conditions",
    database: "flair",
    table: "Credential",
    operator: "and",
    conditions: [
      { search_attribute: "kind", search_type: "equals", search_value: "idp" },
      { search_attribute: "idpSubject", search_type: "equals", search_value: SUBJECT },
    ],
    get_attributes: ["id", "kind", "principalId", "idpProvider", "idpSubject", "status"],
  });
  return Array.isArray(res) ? res : [];
}

function rowFor(rows: any[], id: string): any {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no Credential '${id}' among ${rows.map((r) => r.id).join(", ")}`);
  return row;
}

/** Inject through this instance's ops API after the first subject read or Agent insert. */
function racingFetch(inject: () => Promise<void>, afterAgentInsert = false): typeof fetch {
  let injected = false;
  return (async (url: any, init?: any) => {
    const res = await fetch(url, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (!injected && (afterAgentInsert
      ? body.operation === "insert" && body.table === "Agent"
      : body.operation === "search_by_conditions" && body.table === "Credential")) {
      injected = true;
      await inject();
    }
    return res;
  }) as unknown as typeof fetch;
}

const mappingParams = { opsPortOrUrl: 0, adminUser: "admin", adminPass: "test123", principal: PRINCIPAL, idpSubject: SUBJECT, idpProvider: PROVIDER };

beforeAll(async () => {
  harper = await startHarper();
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

  // Real Agent rows through the ops API, the same table the commands validate.
  for (const id of [PRINCIPAL, OTHER, THIRD]) {
    await adminOp({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{ id, name: id, displayName: id, kind: "human", type: "human", status: "active", publicKey: "pending", createdAt: new Date().toISOString() }],
    });
  }
}, 300_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

/** Seed exactly one active mapping: subject → (principalId, provider). */
async function seedMapping(principalId: string, provider = PROVIDER): Promise<string> {
  const existing = await subjectCreds();
  for (const row of existing) {
    await adminOp({ operation: "update", database: "flair", table: "Credential", records: [{ id: row.id, status: "revoked", updatedAt: new Date().toISOString() }] });
  }
  const credentialId = `cred_race_${principalId}_${provider}_${Date.now().toString(36)}`;
  await adminOp({
    operation: "insert",
    database: "flair",
    table: "Credential",
    records: [{ id: credentialId, kind: "idp", principalId, idpProvider: provider, idpSubject: SUBJECT, status: "active", createdAt: new Date().toISOString() }],
  });
  return credentialId;
}

describe("flair#2222 — principal link/unlink refuse a concurrent change (real Harper)", () => {
  test("link --replace refuses when the Credential row moved after the preflight", async () => {
    const credentialId = await seedMapping(OTHER);
    const params = { ...mappingParams, opsPortOrUrl: opsPort, replace: true };

    const err = await linkPrincipalMapping(params, {
      fetchImpl: racingFetch(async () => {
        await adminOp({ operation: "update", database: "flair", table: "Credential", records: [{ id: credentialId, principalId: THIRD, updatedAt: new Date().toISOString() }] });
      }),
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("mapping-changed-underneath");
    const rows = await subjectCreds();
    const active = rows.filter((r) => r.status !== "revoked");
    expect(rowFor(rows, credentialId), "the row the preflight validated was not overwritten").toMatchObject({ id: credentialId, principalId: THIRD, status: "active" });
    expect(active.length, "no second mapping was created").toBe(1);
  }, 120_000);

  test("unlink refuses when the Credential row moved after the preflight", async () => {
    const credentialId = await seedMapping(PRINCIPAL);

    const err = await unlinkPrincipalMapping(
      { ...mappingParams, opsPortOrUrl: opsPort },
      {
        fetchImpl: racingFetch(async () => {
          await adminOp({ operation: "update", database: "flair", table: "Credential", records: [{ id: credentialId, principalId: OTHER, updatedAt: new Date().toISOString() }] });
        }),
      },
    ).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("mapping-changed-underneath");
    const rows = await subjectCreds();
    expect(rows.filter((r) => r.status !== "revoked").length, "nothing was revoked").toBe(1);
    expect(rowFor(rows, credentialId)).toMatchObject({ id: credentialId, principalId: OTHER, status: "active" });
  }, 120_000);

  test("the provisioner refuses when a concurrent link adds a subject row after the preflight", async () => {
    const credentialId = await seedMapping(PRINCIPAL);

    const err = await provisionIdpIdentityMapping(
      { ...mappingParams, opsPortOrUrl: opsPort, principalKind: "human" },
      {
        fetchImpl: racingFetch(async () => {
          await adminOp({
            operation: "insert",
            database: "flair",
            table: "Credential",
            records: [{ id: `cred_race_new_${sfx}`, kind: "idp", principalId: THIRD, idpProvider: "okta", idpSubject: SUBJECT, status: "active", createdAt: new Date().toISOString() }],
          });
        }),
      },
    ).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("mapping-changed-underneath");
    const rows = await subjectCreds();
    expect(rows.filter((r) => r.status !== "revoked").length, "both active rows survive; nothing was superseded by the refused write").toBe(2);
    expect(rowFor(rows, credentialId)).toMatchObject({ principalId: PRINCIPAL, status: "active" });
  }, 120_000);

  for (const change of ["repoint", "add"] as const) {
    test(`missing-Agent provisioner refuses ${change} after insert without a Credential write`, async () => {
      const credentialId = await seedMapping(OTHER);
      const principal = `race-new-${change}-${sfx}`;
      const writes: string[] = [];
      const inner = racingFetch(async () => {
        await adminOp(change === "repoint"
          ? { operation: "update", database: "flair", table: "Credential", records: [{ id: credentialId, principalId: THIRD }] }
          : { operation: "insert", database: "flair", table: "Credential", records: [{ id: `cred_after_insert_${sfx}`, kind: "idp", principalId: THIRD, idpProvider: "okta", idpSubject: SUBJECT, status: "active", createdAt: new Date().toISOString() }] });
      }, true);
      const fetchImpl = (async (url: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (["insert", "upsert", "update", "delete"].includes(body.operation)) writes.push(`${body.operation}:${body.table}`);
        return inner(url, init);
      }) as typeof fetch;
      const err = await provisionIdpIdentityMapping(
        { ...mappingParams, opsPortOrUrl: opsPort, principal, principalKind: "human" }, { fetchImpl },
      ).then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain("mapping-changed-underneath");
      expect(err!.message).toContain(`Agent '${principal}' was created; no rollback was attempted`);
      expect(err!.message).not.toContain("Nothing was written");
      expect(writes).toEqual(["insert:Agent"]);
      const agents = await adminOp({ operation: "search_by_value", database: "flair", table: "Agent", search_attribute: "id", search_value: principal, get_attributes: ["id", "admin"] });
      expect(agents).toEqual([{ id: principal, admin: false }]);
      const rows = await subjectCreds();
      expect(rowFor(rows, credentialId)).toMatchObject({ principalId: change === "repoint" ? THIRD : OTHER, status: "active" });
      expect(rows.filter(r => r.status !== "revoked")).toHaveLength(change === "repoint" ? 1 : 2);
    }, 120_000);
  }

  test("missing-Agent provisioner accepts its own insert when the mapping is unchanged", async () => {
    const credentialId = await seedMapping(OTHER);
    const principal = `race-new-unchanged-${sfx}`;
    const result = await provisionIdpIdentityMapping({ ...mappingParams, opsPortOrUrl: opsPort, principal, principalKind: "human" });
    expect(result.principalCreated).toBe(true);
    expect(result.credentialId).toBe(credentialId);
    expect(rowFor(await subjectCreds(), credentialId)).toMatchObject({ principalId: principal, status: "active" });
  }, 120_000);

});
