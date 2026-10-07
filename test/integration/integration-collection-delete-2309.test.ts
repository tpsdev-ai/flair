import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

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

let harper: HarperInstance;
const adminAgent = mkAgent("intdel-admin");
const runtimeAgent = mkAgent("intdel-runtime");
const ownerAgent = mkAgent("intdel-owner");

async function adminOp(op: Record<string, any>, instance = harper): Promise<Response> {
  return fetch(instance.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${instance.admin.username}:${instance.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

function basicAdmin(instance = harper): string {
  return "Basic " + btoa(`${instance.admin.username}:${instance.admin.password}`);
}

async function seedRow(id: string, platform: string, agentId = ownerAgent.id, instance = harper): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "Integration",
    records: [{
      id, agentId, platform,
      createdAt: new Date().toISOString(),
    }],
  }, instance);
  expect(res.status, `seed Integration/${id}`).toBe(200);
}

async function readRow(id: string, instance = harper): Promise<any | null> {
  const res = await fetch(`${instance.httpURL}/Integration/${id}`, { headers: { Authorization: basicAdmin(instance) } });
  if (res.status === 404) return null;
  expect(res.status, `read Integration/${id}`).toBe(200);
  return await res.json();
}

async function readByPlatform(platform: string): Promise<any[]> {
  const res = await fetch(`${harper.httpURL}/Integration/?platform=${encodeURIComponent(platform)}`, {
    headers: { Authorization: basicAdmin() },
  });
  expect(res.status, `GET /Integration/?platform=${platform}`).toBe(200);
  const body: any = await res.json();
  return Array.isArray(body) ? body : (body?.results ?? []);
}

describe("Integration collection DELETE (flair#2309)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    for (const a of [adminAgent, runtimeAgent, ownerAgent]) {
      const res = await adminOp({
        operation: "insert", database: "flair", table: "Agent",
        records: [{
          id: a.id, name: a.id,
          role: a === adminAgent ? "admin" : "agent",
          publicKey: a.publicKey, createdAt: new Date().toISOString(),
        }],
      });
      expect(res.status, `seed Agent/${a.id}`).toBe(200);
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("OPERATOR: collection DELETE removes every matched row and leaves an unmatched control row", async () => {
    await seedRow("intdel-op-a", "slack-op");
    await seedRow("intdel-op-b", "slack-op");
    await seedRow("intdel-op-c", "slack-op");
    await seedRow("intdel-op-control", "discord-op");

    const del = await fetch(`${harper.httpURL}/Integration/?platform=slack-op`, {
      method: "DELETE",
      headers: { Authorization: basicAdmin() },
    });
    expect(
      [200, 204],
      `operator collection DELETE returned ${del.status}: ${(await del.text()).slice(0, 300)}`,
    ).toContain(del.status);

    const matched = await readByPlatform("slack-op");
    expect(matched.map((r) => r.id).sort()).toEqual([]);
    for (const id of ["intdel-op-a", "intdel-op-b", "intdel-op-c"]) {
      expect(await readRow(id)).toBeNull();
    }

    const control = await readRow("intdel-op-control");
    expect(control).not.toBeNull();
    expect(control.id).toBe("intdel-op-control");
  }, 60_000);

  for (const [label, projection] of [["object", "select(platform,agentId)"], ["scalar", "select(platform)"]]) {
    test(`OPERATOR: collection DELETE with ${label} projection deletes matched ids`, async () => {
      const platform = `slack-${label}`;
      const ids = [`intdel-${label}-a`, `intdel-${label}-b`, `intdel-${label}-c`];
      for (const id of ids) await seedRow(id, platform);
      const controlId = `intdel-${label}-control`;
      await seedRow(controlId, `discord-${label}`);

      const path = `/Integration/?platform=${platform}&${projection}`;
      const selected = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: basicAdmin() } });
      expect(selected.status).toBe(200);
      const rows = await selected.json();
      expect(rows).toHaveLength(ids.length);
      for (const row of rows) {
        if (label === "scalar") expect(row).toBe(platform);
        else expect(row).toEqual({ platform, agentId: ownerAgent.id });
      }
      const del = await fetch(`${harper.httpURL}${path}`, {
        method: "DELETE",
        headers: { Authorization: basicAdmin() },
      });
      expect([200, 204], await del.text()).toContain(del.status);
      for (const id of ids) expect(await readRow(id)).toBeNull();
      expect((await readRow(controlId))?.id).toBe(controlId);
    }, 60_000);
  }

  for (const principal of [runtimeAgent, adminAgent]) {
    test(`${principal.id}: collection DELETE is refused and deletes nothing`, async () => {
      await seedRow(`${principal.id}-intdel-rt-a`, `${principal.id}-slack-rt`);
      await seedRow(`${principal.id}-intdel-rt-b`, `${principal.id}-slack-rt`);

      await seedRow(`${principal.id}-intdel-rt-own`, `${principal.id}-own-rt`, principal.id);
      const ownPath = `/Integration/${principal.id}-intdel-rt-own`;
      const authenticated = await fetch(`${harper.httpURL}${ownPath}`, {
        headers: { Authorization: ed25519Header(principal, "GET", ownPath) },
      });
      expect(authenticated.status).toBe(200);
      expect((await authenticated.json()).agentId).toBe(principal.id);

      const path = `/Integration/?platform=${principal.id}-slack-rt`;
      const del = await fetch(`${harper.httpURL}${path}`, {
        method: "DELETE",
        headers: { Authorization: ed25519Header(principal, "DELETE", path) },
      });
      expect(del.status).toBe(403);
      expect(await del.json()).toEqual({ error: "integration_directory_requires_operator: deleting by a collection or query target is operator-only" });

      const still = await readByPlatform(`${principal.id}-slack-rt`);
      expect(still.map((r) => r.id).sort()).toEqual([`${principal.id}-intdel-rt-a`, `${principal.id}-intdel-rt-b`]);
      for (const id of [`${principal.id}-intdel-rt-a`, `${principal.id}-intdel-rt-b`, `${principal.id}-intdel-rt-own`]) {
        expect((await readRow(id))?.id).toBe(id);
      }
    }, 60_000);
  }

  test("OPERATOR: a throw after the second staged delete returns 500 and rolls back the rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-integration-delete-failure-"));
    let failingHarper: HarperInstance | undefined;
    try {
      for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
        cpSync(join(process.cwd(), entry), join(dir, entry), { recursive: true });
      }
      symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");
      const resourcePath = join(dir, "dist", "resources", "Integration.js");
      const resource = readFileSync(resourcePath, "utf8");
      writeFileSync(resourcePath, resource + `
const originalWriteDelete = Integration.prototype._writeDelete;
Integration.prototype._writeDelete = function(id, options) {
  const result = originalWriteDelete.call(this, id, options);
  this.testDeleteCount = (this.testDeleteCount || 0) + 1;
  if (this.testDeleteCount === 2) throw new Error("forced Integration failure after second staged delete");
  return result;
};
`);
      failingHarper = await startHarper({ cwd: dir });
      const ids = ["intdel-failure-a", "intdel-failure-b", "intdel-failure-c"];
      for (const id of ids) await seedRow(id, "slack-failure", ownerAgent.id, failingHarper);
      await seedRow("intdel-failure-control", "discord-failure", ownerAgent.id, failingHarper);
      const del = await fetch(`${failingHarper.httpURL}/Integration/?platform=slack-failure&sort(id)`, {
        method: "DELETE",
        headers: { Authorization: basicAdmin(failingHarper) },
      });
      expect(del.status).toBe(500);
      const error = await del.json();
      expect(error.type).toBe("error:Error");
      expect(error.title).toBe("forced Integration failure after second staged delete");
      for (const id of [...ids, "intdel-failure-control"]) {
        expect((await readRow(id, failingHarper))?.id).toBe(id);
      }
    } finally {
      try {
        if (failingHarper) await stopHarper(failingHarper);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 240_000);
});
