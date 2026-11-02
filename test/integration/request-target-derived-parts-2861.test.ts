/**
 * request-target-derived-parts-2861.test.ts — on real Harper, the listing at
 * `/AdminMemoryCandidates/{agentId}` reads the query the raw target carries, and
 * a signed request is verified over the target its route serves.
 *
 * A target a WHATWG parse would rewrite (a raw `#` stays in Harper's path and
 * query) is refused with the named 400 `non_canonical_request_target`; encoded
 * forms, duplicate query keys and a raw `#` that changes no query keep working.
 * Every REST request under test goes over a raw socket.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import nacl from "tweetnacl";
import {
  HarperInstance,
  startHarper,
  stopHarpers,
  HARPER_START_BUDGET_MS,
  HARPER_STOP_BUDGET_MS,
} from "../helpers/harper-lifecycle";

const AGENT = "signer-agent";
const NOW = new Date().toISOString();

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
const agent = mkAgent(AGENT);

/** Sign the WHATWG pathname and search, as a client that builds a URL does. */
function ed25519Header(method: string, target: string): string {
  const signed = new URL(target, "http://localhost");
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${signed.pathname}${signed.search}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(harper: HarperInstance): void {
  for (const raw of [harper.httpURL, harper.opsURL]) {
    const u = new URL(raw);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} is not an instance this test started`);
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

/** Send ONE request over a raw socket with `target` exactly as written. */
function rawRequest(
  base: string,
  method: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(Number(port), hostname);
    socket.setTimeout(30_000, () => socket.destroy(new Error(`raw ${method} ${target}: no response in 30 s`)));
    socket.on("connect", () => {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: ${hostname}:${port}`, "Connection: close"];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`raw ${method} ${target}: no complete response`));
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
const adminAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
const adminGet = (target: string) => rawRequest(harper.httpURL, "GET", target, { Authorization: adminAuth() });
const signedGet = (target: string) =>
  rawRequest(harper.httpURL, "GET", target, { Authorization: ed25519Header("GET", target) });

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ database: "flair", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} ${res.status}: ${await res.text()}`);
  return res.json();
}
const insert = (table: string, record: Record<string, unknown>) => ops({ operation: "insert", table, records: [record] });

function expectNonCanonical(res: RawResponse, label: string): void {
  expect(res.status, `${label}: ${res.body.slice(0, 300)}`).toBe(400);
  expect(JSON.parse(res.body).error, label).toBe("non_canonical_request_target");
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  await insert("Agent", {
    id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: NOW,
  });
  for (const id of ["cand-a", "cand-b", "cand-c"]) {
    await insert("MemoryCandidate", { id, agentId: "cand-agent", claim: "c", generatedAt: NOW, status: "pending" });
    await insert("MemoryCandidate", { id: `${id}-raw`, agentId: "cand-agent#x", claim: "c", generatedAt: NOW, status: "pending" });
  }
  for (const id of [`${AGENT}`, `${AGENT}#x`, `${AGENT}{x}`, `${AGENT}/x`, `${AGENT}\\x`]) {
    await insert("Memory", { id, agentId: agent.id, content: `marker-of ${id}`, durability: "standard", createdAt: NOW });
  }
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  const dir = harper?.installDir;
  if (harper) await stopHarpers([harper]);
  if (dir?.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS * 2);

describe("GET /AdminMemoryCandidates reads the query the raw target carries", () => {
  it("a canonical query is read as before", async () => {
    const one = await adminGet("/AdminMemoryCandidates/cand-agent?limit=1");
    expect(one.status, one.body).toBe(200);
    expect(JSON.parse(one.body)).toEqual({ candidates: [{ id: "cand-a" }], hasMore: true });

    const twice = await adminGet("/AdminMemoryCandidates/cand-agent?limit=2");
    expect(twice.status, twice.body).toBe(200);
    expect(JSON.parse(twice.body).candidates.map((c: any) => c.id)).toEqual(["cand-a", "cand-b"]);

    const repeated = await adminGet("/AdminMemoryCandidates/cand-agent?limit=1&limit=2");
    expect(repeated.status, repeated.body).toBe(200);
    expect(JSON.parse(repeated.body).candidates.map((c: any) => c.id)).toEqual(["cand-a"]);
  }, 30_000);

  it("a raw `#` before the query separator is refused", async () => {
    expectNonCanonical(await adminGet("/AdminMemoryCandidates/cand-agent#x?limit=1"), "#x?limit=1");
  }, 30_000);

  it("a raw `#` inside the query is refused", async () => {
    expectNonCanonical(await adminGet("/AdminMemoryCandidates/cand-agent?limit=1#x"), "?limit=1#x");
    expectNonCanonical(await adminGet("/AdminMemoryCandidates/cand-agent?after=cand-a#x"), "?after=cand-a#x");
  }, 30_000);

  it("a raw `#` that changes no query still lists the id's rows", async () => {
    for (const target of ["/AdminMemoryCandidates/cand-agent#x", "/AdminMemoryCandidates/cand-agent%23x"]) {
      const res = await adminGet(target);
      expect(res.status, `${target}: ${res.body}`).toBe(200);
      expect(JSON.parse(res.body).candidates.map((c: any) => c.id)).toEqual(["cand-a-raw", "cand-b-raw", "cand-c-raw"]);
    }
  }, 30_000);
});

describe("a signed request is verified over the target the route serves", () => {
  it("a raw `#` in the path is refused before verification", async () => {
    expectNonCanonical(await signedGet(`/Memory/${AGENT}#x`), "path #x");
    expectNonCanonical(await signedGet(`/Memory/${AGENT}#x?x=1`), "path #x with query");
  }, 30_000);

  it("a raw `#` in the query is refused before verification", async () => {
    expectNonCanonical(await signedGet(`/Memory/${AGENT}?x=1#y`), "query #y");
  }, 30_000);

  it("a target the URL parser would encode is refused before verification", async () => {
    expectNonCanonical(await signedGet(`/Memory/${AGENT}{x}`), "raw braces");
  }, 30_000);

  it("the refusal comes before the signature is checked", async () => {
    const res = await rawRequest(harper.httpURL, "GET", `/Memory/${AGENT}#x`, {
      Authorization: `TPS-Ed25519 ${AGENT}:${Date.now()}:${randomUUID()}:not-a-signature`,
    });
    expectNonCanonical(res, "garbage signature");
  }, 30_000);

  it("encoded forms are verified and served as before", async () => {
    for (const [target, id] of [
      [`/Memory/${AGENT}%23x`, `${AGENT}#x`],
      [`/Memory/${AGENT}%7Bx%7D`, `${AGENT}{x}`],
      [`/Memory/${AGENT}%2Fx`, `${AGENT}/x`],
      [`/Memory/${AGENT}%5Cx`, `${AGENT}\\x`],
    ] as const) {
      const res = await signedGet(target);
      expect(res.status, `${target}: ${res.body.slice(0, 300)}`).toBe(200);
      expect(JSON.parse(res.body).id, target).toBe(id);
    }
  }, 60_000);
});
