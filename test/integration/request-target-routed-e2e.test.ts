/**
 * request-target-routed-e2e.test.ts — on real Harper, every middleware decision
 * is made on the record and resource Harper actually routes to.
 *
 * Three guarantees, each exercised over a RAW socket where routing matters (so
 * the request target reaches Harper byte for byte, not normalized by fetch):
 *
 *   1. Record id. The shared owner guard decides on the FULL routed id (the
 *      whole decoded remainder after the table), so a non-owner mutation of an
 *      id that contains `/` is refused and the row is unchanged, while an
 *      owner's mutation of a slash-containing id succeeds.
 *   2. Routed resource name. The OAuth rate-limit policy and the public-path
 *      allowance decide on the resource Harper routes to, including its
 *      file-type-suffix fallback: a suffixed form of a rate-limited route is
 *      counted, and a suffixed form of a public route is served.
 *   3. Backfill target. A successful create whose caller-supplied header names a
 *      different, other-owned row leaves that other row untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import {
  HarperInstance,
  startHarper,
  stopHarper,
  HARPER_START_BUDGET_MS,
  HARPER_STOP_BUDGET_MS,
} from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, target: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${target}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

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

interface RawResponse { status: number; headers: Record<string, string>; body: string }

function dechunk(raw: Buffer): Buffer {
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", at);
    if (lineEnd < 0) break;
    const size = parseInt(raw.subarray(at, lineEnd).toString("latin1").split(";")[0]!.trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** Send ONE HTTP/1.1 request over a raw socket with `target` exactly as written. */
function rawRequest(
  base: string,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(Number(port), hostname);
    socket.setTimeout(30_000, () => socket.destroy(new Error(`raw ${method} ${target}: no response in 30 s`)));
    socket.on("connect", () => {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: ${hostname}:${port}`, "Connection: close"];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body ?? ""}`);
    });
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`raw ${method} ${target}: no complete response (${all.length} bytes)`));
      const head = all.subarray(0, split).toString("latin1").split("\r\n");
      const status = Number(head[0]!.split(" ")[1]);
      const parsed: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const c = line.indexOf(":");
        if (c > 0) parsed[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      let rest: Buffer = all.subarray(split + 4);
      if (/chunked/i.test(parsed["transfer-encoding"] ?? "")) rest = dechunk(rest);
      else if (parsed["content-length"] !== undefined) rest = rest.subarray(0, Number(parsed["content-length"]));
      resolve({ status, headers: parsed, body: rest.toString("utf8") });
    });
  });
}

let harper: HarperInstance;
const owner = mkAgent("rtr-owner");
const other = mkAgent("rtr-other");
const NOW = new Date().toISOString();

function signed(agent: TestAgent, method: string, target: string, body?: unknown, extra: Record<string, string> = {}): Promise<RawResponse> {
  const headers: Record<string, string> = { Authorization: ed25519Header(agent, method, target), ...extra };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return rawRequest(harper.httpURL, method, target, headers, body === undefined ? undefined : JSON.stringify(body));
}

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seed(table: string, rec: Record<string, any>): Promise<void> {
  const r = await adminOp({ operation: "upsert", database: "flair", table, records: [rec] });
  expect(r.status, `seed ${table} ${r.status}`).toBe(200);
}
async function readRow(table: string, id: string, attrs: string[]): Promise<any> {
  const r = await adminOp({ operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: attrs });
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : null;
}

// A rate-limit budget small enough to spend in a few requests.
const OAUTH_LIMIT = 5;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["FLAIR_OAUTH_RATE_LIMIT", "FLAIR_RATE_LIMIT", "FLAIR_TRUSTED_PROXY"]) savedEnv[k] = process.env[k];
  process.env.FLAIR_OAUTH_RATE_LIMIT = String(OAUTH_LIMIT);
  delete process.env.FLAIR_RATE_LIMIT;
  delete process.env.FLAIR_TRUSTED_PROXY;

  harper = await startHarper();
  assertOwnInstance(harper);
  for (const a of [owner, other]) {
    await seed("Agent", { id: a.id, name: a.id, role: "agent", admin: false, publicKey: a.publicKey, createdAt: NOW });
  }
  // (1) Record id: a caller-owned prefix row and an other-owned slash-id row.
  await seed("Asset", { id: "rtr-safe", agentId: owner.id, memoryId: "m0", contentType: "image/png", createdAt: NOW });
  await seed("Asset", { id: "rtr-safe/victim", agentId: other.id, memoryId: "m-victim", contentType: "image/png", createdAt: NOW });
  await seed("Asset", { id: "rtr-own/slash", agentId: owner.id, memoryId: "m-own", contentType: "image/png", createdAt: NOW });
  // (3) Backfill: an other-owned Memory row the create's header will name.
  await seed("Memory", { id: "rtr-victim-mem", agentId: other.id, content: "victim content", durability: "persistent", createdAt: NOW, updatedAt: NOW });
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}, HARPER_STOP_BUDGET_MS);

describe("(1) the owner guard decides on the full routed record id", () => {
  it("a non-owner PATCH of an id containing `/` is refused and leaves the row unchanged", async () => {
    for (const target of ["/Asset/rtr-safe%2Fvictim", "/Asset/rtr-safe/victim"]) {
      const res = await signed(owner, "PATCH", target, { memoryId: "m-hijacked" });
      expect([401, 403]).toContain(res.status); // refused, not applied
      const row = await readRow("Asset", "rtr-safe/victim", ["id", "agentId", "memoryId"]);
      expect(row?.agentId, `${target} left owner intact`).toBe(other.id);
      expect(row?.memoryId, `${target} left value intact`).toBe("m-victim");
    }
  }, 60_000);

  it("the owner's PATCH of its own slash-containing id succeeds", async () => {
    const res = await signed(owner, "PATCH", "/Asset/rtr-own%2Fslash", { memoryId: "m-own-changed" });
    expect(res.status, `${res.status}: ${res.body.slice(0, 200)}`).toBeLessThan(300);
    const row = await readRow("Asset", "rtr-own/slash", ["id", "agentId", "memoryId"]);
    expect(row?.memoryId).toBe("m-own-changed");
  }, 60_000);
});

describe("(2) rate-limit and public decisions use the routed resource name", () => {
  it("a suffixed form of the rate-limited OAuth route is counted, exactly like the bare route", async () => {
    // Positive control: the bare route is served (400 invalid_grant), not 429.
    const control = await rawRequest(harper.httpURL, "POST", "/OAuthToken", { "content-type": "application/json" }, JSON.stringify({ grant_type: "authorization_code", code: "nope", client_id: "nope" }));
    expect(control.status).not.toBe(429);

    // Spend the shared bucket through the SUFFIX form; it must reach the limiter.
    let saw429 = false;
    for (let i = 0; i < OAUTH_LIMIT + 2; i++) {
      const res = await rawRequest(harper.httpURL, "POST", "/OAuthToken.json", { "content-type": "application/json" }, JSON.stringify({ grant_type: "authorization_code", code: "nope", client_id: "nope" }));
      if (res.status === 429) { saw429 = true; break; }
      expect(res.status).toBe(400); // served normally while budget remains
    }
    expect(saw429, "the suffixed OAuth route reached the rate limiter").toBe(true);
  }, 60_000);

  it("a suffixed form of a public route is served, not refused", async () => {
    // Positive control: the bare public route answers 200.
    const control = await rawRequest(harper.httpURL, "GET", "/Health", {});
    expect(control.status).toBe(200);
    // The suffixed form routes to the same public resource and is served, never
    // refused by the middleware and never the canonical-target 400.
    const res = await rawRequest(harper.httpURL, "GET", "/Health.json", {});
    expect(res.status, `${res.status}: ${res.body.slice(0, 200)}`).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  }, 30_000);
});

describe("(3) the embedding backfill targets only the committed record", () => {
  it("a successful create whose header names another owner's row leaves that row untouched", async () => {
    const before = await readRow("Memory", "rtr-victim-mem", ["id", "agentId", "content", "embedding"]);
    expect(before?.agentId).toBe(other.id);

    // A canonical collection create by `owner`, with a caller header naming the
    // other-owned row. The create must succeed as the caller's own new row.
    const res = await signed(owner, "POST", "/Memory", {
      agentId: owner.id, content: "my own new memory", durability: "persistent",
    }, { "x-memory-id": "rtr-victim-mem" });
    expect(res.status, `create ${res.status}: ${res.body.slice(0, 200)}`).toBeLessThan(300);

    // Let any asynchronous backfill settle, then the other-owned row is unchanged.
    await new Promise((r) => setTimeout(r, 750));
    const after = await readRow("Memory", "rtr-victim-mem", ["id", "agentId", "content", "embedding"]);
    expect(after?.agentId).toBe(other.id);
    expect(after?.content).toBe("victim content");
    expect(JSON.stringify(after?.embedding ?? null)).toBe(JSON.stringify(before?.embedding ?? null));
  }, 60_000);
});
