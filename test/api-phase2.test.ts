import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";

let appUrl = "";
let closeServer: (() => Promise<void>) | null = null;
let secretKeyB64 = "";

function signHeader(method: string, originalUrl: string, agentId: string): string {
  const ts = Date.now();
  const nonce = Math.random().toString(36).slice(2);
  const payload = `${method}:${originalUrl}:${ts}:${nonce}`;
  const sig = nacl.sign.detached(Buffer.from(payload), Buffer.from(secretKeyB64, "base64"));
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function req(method: string, path: string, body?: any) {
  const headers: Record<string, string> = {
    authorization: signHeader(method, path, "flint"),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${appUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

beforeEach(async () => {
  if (closeServer) await closeServer();

  const dbRoot = mkdtempSync(join(tmpdir(), "flair-phase2-"));
  process.env.FLAIR_DB_PATH = join(dbRoot, "db.json");

  const kp = nacl.sign.keyPair();
  secretKeyB64 = Buffer.from(kp.secretKey).toString("base64");
  const publicKey = Buffer.from(kp.publicKey).toString("base64");

  writeFileSync(process.env.FLAIR_DB_PATH, JSON.stringify({
    agents: [{ id: "flint", name: "Flint", publicKey, createdAt: new Date().toISOString() }],
    integrations: [],
    memories: [],
    souls: [],
  }));

  const { createApp } = await import(`../src/server.js?x=${Date.now()}`);
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as any).port;
  appUrl = `http://127.0.0.1:${port}`;
  closeServer = () => new Promise((resolve) => server.close(() => resolve()));
});

describe("phase2 api", () => {
  test("requires auth on new endpoints", async () => {
    const res = await fetch(`${appUrl}/memory`);
    expect(res.status).toBe(401);
  });

  test("memory CRUD + search + durability delete guard", async () => {
    const created = await req("POST", "/memory", {
      agentId: "flint",
      content: "we chose rocksdb",
      tags: ["decision", "db"],
      durability: "permanent",
      source: "design-review",
    });
    expect(created.status).toBe(201);
    const id = created.json.id;

    const fetched = await req("GET", `/memory/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json.content).toContain("rocksdb");

    const listed = await req("GET", "/memory?agentId=flint&tag=db");
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.json)).toBe(true);
    expect(listed.json.length).toBe(1);

    const search = await req("POST", "/memory/search", { agentId: "flint", q: "rocks", tag: "decision" });
    expect(search.status).toBe(200);
    expect(search.json.results.length).toBe(1);

    const del = await req("DELETE", `/memory/${id}`);
    expect(del.status).toBe(403);
    expect(del.json.error).toBe("permanent_memory_cannot_be_deleted");
  });

  test("ephemeral memory uses ttl and expires", async () => {
    const created = await req("POST", "/memory", {
      agentId: "flint",
      content: "temp note",
      durability: "ephemeral",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(created.status).toBe(201);

    const listed = await req("GET", "/memory?agentId=flint");
    expect(listed.status).toBe(200);
    expect(listed.json.length).toBe(0);
  });

  test("soul CRUD defaults durability to permanent", async () => {
    const created = await req("POST", "/soul", {
      agentId: "flint",
      key: "voice",
      value: "direct",
    });
    expect(created.status).toBe(201);
    expect(created.json.durability).toBe("permanent");
    const id = created.json.id;

    const got = await req("GET", `/soul/${id}`);
    expect(got.status).toBe(200);

    const upd = await req("PUT", `/soul/${id}`, {
      agentId: "flint",
      key: "voice",
      value: "concise",
      durability: "persistent",
    });
    expect(upd.status).toBe(200);
    expect(upd.json.durability).toBe("persistent");

    const listed = await req("GET", "/soul?agentId=flint");
    expect(listed.status).toBe(200);
    expect(listed.json.length).toBe(1);
  });
});
