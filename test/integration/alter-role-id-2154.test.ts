// flair#2154 — the CLI's role-update path. Harper's ops API addresses a role by
// its `id`, and 5.2.8 refuses an `alter_role` without one ("Id can't be blank"),
// so `ensureFlairAgentRole` and `ensureFlairPairInitiatorRole` could not bring an
// existing role's permissions into spec.
//
// The unit lane mocks `fetch`, so it can only see the body the code builds, not
// Harper's verdict on it. This drives the REAL functions against a spawned Harper
// and down each one's existing-role (alter) path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureFlairAgentRole, ensureFlairPairInitiatorRole } from "../../src/cli";
import { type HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

let harper: HarperInstance;

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function permissionOf(name: string): Promise<Record<string, unknown>> {
  const roles = await ops({ operation: "list_roles" });
  if (!Array.isArray(roles)) throw new Error("list_roles did not return a list of roles");
  const row = (roles as Array<{ role?: string; name?: string; permission?: unknown }>).find(
    (r) => r.role === name || r.name === name,
  );
  if (!row) throw new Error(`role '${name}' is not on the instance`);
  const permission = row.permission;
  // A read that returned no permission established nothing; only the empty
  // object `{}` (the sentinel below) is a legitimate value here.
  if (!permission || typeof permission !== "object") {
    throw new Error(`list_roles returned no permission for '${name}' (${JSON.stringify(permission)})`);
  }
  return permission as Record<string, unknown>;
}

/** Give a role permissions that differ from its spec, addressing it by the id list_roles returned. */
async function setPermissionTo(name: string, permission: unknown): Promise<void> {
  const roles = await ops({ operation: "list_roles" });
  const row = (roles as Array<{ role?: string; name?: string; id?: string }>).find(
    (r) => r.role === name || r.name === name,
  );
  if (!row || typeof row.id !== "string" || row.id.length === 0) {
    throw new Error(`role '${name}' has no id in list_roles`);
  }
  await ops({ operation: "alter_role", id: row.id, role: name, permission });
}

// An empty permission is accepted by 5.2.8 and equals neither spec, so an
// ensure() call that reads it must take the alter path. (`{ super_user: true, ... }`
// cannot stand in: 5.2.8 refuses it with "Roles with 'super_user' set to true
// cannot have other permissions set.")
const DIFFERENT = {};

describe("CLI role update sends the id alter_role needs (flair#2154)", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("ensureFlairAgentRole updates an existing flair_agent role", async () => {
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    const created = await permissionOf("flair_agent");
    expect(Object.keys(created).length).toBeGreaterThan(0);

    await setPermissionTo("flair_agent", DIFFERENT);
    expect(await permissionOf("flair_agent")).toEqual(DIFFERENT);

    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    const updated = await permissionOf("flair_agent");
    expect(updated).toEqual(created);
    expect(updated).not.toEqual(DIFFERENT);
  }, 120_000);

  test("ensureFlairPairInitiatorRole updates an existing flair_pair_initiator role", async () => {
    await ensureFlairPairInitiatorRole(harper.opsURL, harper.admin.username, harper.admin.password);
    const created = await permissionOf("flair_pair_initiator");
    expect(Object.keys(created).length).toBeGreaterThan(0);

    await setPermissionTo("flair_pair_initiator", DIFFERENT);
    expect(await permissionOf("flair_pair_initiator")).toEqual(DIFFERENT);

    await ensureFlairPairInitiatorRole(harper.opsURL, harper.admin.username, harper.admin.password);
    const updated = await permissionOf("flair_pair_initiator");
    expect(updated).toEqual(created);
    expect(updated).not.toEqual(DIFFERENT);
  }, 120_000);
});
