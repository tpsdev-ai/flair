/**
 * request-target-routed-e2e.test.ts — on real Harper, the middleware's by-name
 * and by-id decisions are made on the record and resource Harper's REST matcher
 * routes to.
 *
 * Each guarantee is exercised over a RAW socket where routing matters (so the
 * request target reaches Harper byte for byte, not normalized by fetch):
 *
 *   1. Record id. The shared owner guard decides on the FULL routed id (the
 *      whole decoded remainder after the table), so a non-owner mutation of an
 *      id that contains `/` is refused and the row is unchanged, while an
 *      owner's mutation of a slash-containing id succeeds; a non-owner PATCH of a
 *      content-type-suffixed id answers the middleware's own named 503 when its
 *      stored-owner read fails.
 *   2. Routed resource name. The OAuth rate-limit policy and the public-path
 *      allowance decide on the resource Harper routes to, including its
 *      file-type-suffix fallback: a suffixed form of a rate-limited route is
 *      counted, and a suffixed form of a public route is served.
 *   3. Backfill target. The middleware's embedding backfill writes its vector to
 *      the row the write COMMITTED — the returned id for a successor and for a
 *      collection create — never the URL or caller-header id.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import {
  HarperInstance,
  startHarper,
  stopHarper,
  HARPER_START_BUDGET_MS,
  HARPER_STOP_BUDGET_MS,
} from "../helpers/harper-lifecycle";
import {
  componentWithOwnerGuardLoadFailure,
  LOAD_FAILURE_MARKER,
  ARM_FILE,
  type FailingComponent,
} from "../helpers/owner-guard-load-failure-component";

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
let component: FailingComponent;
const owner = mkAgent("rtr-owner");
const other = mkAgent("rtr-other");
const NOW = new Date().toISOString();

/** Arm / disarm the injected marker-id row-load failure via the ROOTPATH sentinel. */
function arm(): void { writeFileSync(join(harper.installDir, ARM_FILE), "1"); }
function disarm(): void { const p = join(harper.installDir, ARM_FILE); if (existsSync(p)) rmSync(p, { force: true }); }

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

/**
 * The vector length stored on a Memory row, polled until it exceeds 100 (the
 * backfill's own vector) or the deadline passes. A create that stores a short
 * caller-supplied vector leaves the row short until the middleware's embedding
 * backfill recomputes and writes it — so this is a backfill-specific write
 * against exactly this id.
 */
async function awaitBackfillVector(id: string, deadlineMs = 20_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let len = 0;
  while (Date.now() < deadline) {
    const row = await readRow("Memory", id, ["id", "embedding"]);
    len = Array.isArray(row?.embedding) ? row.embedding.length : 0;
    if (len > 100) return len;
    await new Promise((r) => setTimeout(r, 250));
  }
  return len;
}

/**
 * Whether Harper's log carries the backfill's own completion line for `id`
 * (`[auto-embed] <id>: <n>d`, written only by the middleware's embedding
 * backfill), polled to a deadline. This names the id the backfill wrote, so it
 * does not depend on what a row may have inherited from another row.
 */
async function awaitAutoEmbedLog(id: string, deadlineMs = 20_000): Promise<boolean> {
  const needle = `[auto-embed] ${id}:`;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if ((harper.getLog?.() ?? "").includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// A rate-limit budget small enough to spend in a few requests.
const OAUTH_LIMIT = 5;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["FLAIR_OAUTH_RATE_LIMIT", "FLAIR_RATE_LIMIT", "FLAIR_TRUSTED_PROXY"]) savedEnv[k] = process.env[k];
  process.env.FLAIR_OAUTH_RATE_LIMIT = String(OAUTH_LIMIT);
  delete process.env.FLAIR_RATE_LIMIT;
  delete process.env.FLAIR_TRUSTED_PROXY;

  component = componentWithOwnerGuardLoadFailure();
  harper = await startHarper({ cwd: component.dir });
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
  if (harper) { disarm(); await stopHarper(harper); }
  if (component) component.cleanup();
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

  it("a non-owner PATCH of a content-type-SUFFIXED id is decided by the middleware's stored-owner read", async () => {
    // A non-admin PATCH to a suffixed address whose stored row cannot be read
    // answers the middleware's own named 503 owner_lookup_failed: the middleware
    // reads the stored row before the resource owner guard can run, and the
    // resource guard's refusal is a 403 with a different body. That 503 is
    // produced only by the middleware's stored-owner read, so this observes the
    // middleware's decision on the id Harper routes to rather than accepting an
    // authentication or resource-guard refusal.
    //
    // `/Asset/<id>.json` routes to Asset id `<id>`: Harper strips the `.json`
    // content-type suffix.
    const id = `${LOAD_FAILURE_MARKER}-suffix-${randomUUID()}`;
    await seed("Asset", { id, agentId: other.id, memoryId: "m-victim", contentType: "image/png", createdAt: NOW });
    const before = await readRow("Asset", id, ["id", "agentId", "memoryId"]);
    expect(before?.agentId, "the other-owned row was not seeded").toBe(other.id);

    arm();
    try {
      const res = await signed(owner, "PATCH", `/Asset/${id}.json`, { memoryId: "m-hijacked-suffix" });
      expect(res.status, `/Asset/${id}.json → ${res.status}: ${res.body.slice(0, 200)}`).toBe(503);
      expect(JSON.parse(res.body).error, "must answer with the middleware's named refusal").toBe("owner_lookup_failed");
    } finally {
      disarm();
    }
    expect(await readRow("Asset", id, ["id", "agentId", "memoryId"]), "the suffixed PATCH changed the other-owned row").toEqual(before);
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

  it("a suffixed-name-PLUS-remainder OAuth form (routed to the bare resource) is also counted", async () => {
    // `/OAuthToken.json/x` is dispatched by Harper's matcher to `OAuthToken`
    // with an empty remainder; the limiter must count it too. The bucket from
    // the previous case is already spent in this 60s window, so one request
    // suffices — assert it is throttled rather than served unthrottled.
    const res = await rawRequest(harper.httpURL, "POST", "/OAuthToken.json/x", { "content-type": "application/json" }, JSON.stringify({ grant_type: "authorization_code", code: "nope", client_id: "nope" }));
    expect(res.status, `${res.status}: ${res.body.slice(0, 200)}`).toBe(429);
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
  it("a successful create whose header names another owner's row backfills the committed row, not the header's", async () => {
    const before = await readRow("Memory", "rtr-victim-mem", ["id", "agentId", "content", "embedding"]);
    expect(before?.agentId).toBe(other.id);
    expect(Array.isArray(before?.embedding) && before.embedding.length > 0, "the header-named row must start without a vector").toBe(false);

    // A canonical collection create by `owner`, with a caller header naming the
    // other-owned row. The create must succeed as the caller's own new row, and
    // the committed id (what the backfill targets) is that new row — never the
    // header's id. The body supplies a short vector, so the committed row stays
    // short unless the middleware's embedding backfill recomputes and writes it.
    const res = await signed(owner, "POST", "/Memory", {
      agentId: owner.id, content: "my own new memory", durability: "persistent",
      embedding: [0.01, 0.02, 0.03],
    }, { "x-memory-id": "rtr-victim-mem" });
    expect(res.status, `create ${res.status}: ${res.body.slice(0, 200)}`).toBeLessThan(300);
    const committedId = JSON.parse(res.body).id as string;
    expect(committedId).not.toBe("rtr-victim-mem");

    const len = await awaitBackfillVector(committedId);
    expect(len, "the backfill wrote no vector to the committed row").toBeGreaterThan(100);

    // The other-owned row keeps its owner, content and absence of a vector — the
    // backfill did not target the header's id.
    const after = await readRow("Memory", "rtr-victim-mem", ["id", "agentId", "content", "embedding"]);
    expect(after?.agentId).toBe(other.id);
    expect(after?.content).toBe("victim content");
    expect(Array.isArray(after?.embedding) && after.embedding.length > 0, "the header-named row received a vector").toBe(false);
  }, 60_000);

  it("a by-id POST that commits a SUCCESSOR with a different id backfills the successor, not the URL id", async () => {
    // A skill POST to a URL id, then an identical retry commits a SUCCESSOR with
    // a different id (flair#2263). The committed id the backfill uses comes from
    // the write RESULT, not the URL id. The body supplies a short vector, so the
    // successor stays short unless the backfill reads the RETURNED successor id.
    const skillId = `rtr-skill-${randomUUID()}`;
    const body = { agentId: owner.id, content: "successor backfill body", trigger: "when the committed id differs from the url", tags: ["skill"], durability: "persistent", embedding: [0.01, 0.02, 0.03] };

    const first = await signed(owner, "POST", `/Memory/${encodeURIComponent(skillId)}`, body);
    expect(first.status, `first ${first.status}: ${first.body.slice(0, 200)}`).toBeLessThan(300);
    expect(JSON.parse(first.body).id).toBe(skillId);

    const retry = await signed(owner, "POST", `/Memory/${encodeURIComponent(skillId)}`, body);
    expect(retry.status, `retry ${retry.status}: ${retry.body.slice(0, 200)}`).toBeLessThan(300);
    const successorId = JSON.parse(retry.body).id as string;
    expect(successorId).not.toBe(skillId);

    const successor = await readRow("Memory", successorId, ["id", "agentId", "supersedes"]);
    expect(successor?.agentId).toBe(owner.id);
    expect(successor?.supersedes).toBe(skillId);

    const len = await awaitBackfillVector(successorId);
    expect(len, "the backfill wrote no vector to the successor row").toBeGreaterThan(100);
    // The backfill's own log line names the id it wrote; it must be the successor,
    // never the URL id.
    expect(await awaitAutoEmbedLog(successorId), "the backfill logged no write for the successor id").toBe(true);
  }, 120_000);
});
