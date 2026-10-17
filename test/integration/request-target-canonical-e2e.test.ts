/**
 * request-target-canonical-e2e.test.ts — on real Harper, the auth middleware
 * answers a non-canonical request target with the named 400
 * `non_canonical_request_target` before any other request processing, while
 * ordinary signed writes, reads and deletes on canonical targets — including a
 * record id containing `/`, sent as `%2F` — work exactly as before.
 *
 * Every request here goes over a RAW socket, so the request target reaches
 * Harper byte for byte as written: `fetch` (and Bun's node:http client) would
 * normalize the path first.
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

/** Refuse to talk to anything but this test's own ephemeral instance. */
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

/**
 * Send ONE HTTP/1.1 request over a raw socket with `target` as the request
 * target, exactly as written, and read the whole response.
 */
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
const agent = mkAgent("canon-target-agent");

function signed(method: string, target: string, body?: unknown): Promise<RawResponse> {
  const headers: Record<string, string> = { Authorization: ed25519Header(agent, method, target) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return rawRequest(harper.httpURL, method, target, headers, body === undefined ? undefined : JSON.stringify(body));
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    }),
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}, HARPER_START_BUDGET_MS);

afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

const NON_CANONICAL: Array<[string, string]> = [
  ["a raw `..` segment", "/Memory/../Agent"],
  ["a raw `.` segment", "/Memory/./canon-x"],
  ["an encoded `..` segment", "/Memory/%2e%2e/Agent"],
  ["an encoded `.` segment, upper case", "/Memory/%2E/canon-x"],
  ["a mixed `.%2E` segment", "/Memory/.%2E/Agent?limit=1"],
  ["an empty segment after the leading slash", "//Memory"],
  ["an empty segment mid-path", "/Memory//canon-x"],
  ["a raw backslash", "/Memory\\canon-x"],
];

describe("a non-canonical request target gets the named 400 on real Harper", () => {
  for (const [label, target] of NON_CANONICAL) {
    it(`${label}: ${JSON.stringify(target)} (anonymous and signed)`, async () => {
      for (const res of [
        await rawRequest(harper.httpURL, "GET", target),
        await signed("GET", target),
      ]) {
        expect(res.status, `${target} → ${res.status}: ${res.body.slice(0, 200)}`).toBe(400);
        expect(JSON.parse(res.body).error).toBe("non_canonical_request_target");
      }
    }, 30_000);
  }

  it("a non-canonical DELETE is refused the same way, and the HEAD form carries no body", async () => {
    const del = await signed("DELETE", "/Memory/%2e%2e/Agent");
    expect(del.status).toBe(400);
    expect(JSON.parse(del.body).error).toBe("non_canonical_request_target");
    const head = await rawRequest(harper.httpURL, "HEAD", "/Memory/../Agent");
    expect(head.status).toBe(400);
    expect(head.body).toBe("");
  }, 30_000);
});

describe("ordinary signed traffic on canonical targets is unchanged", () => {
  for (const [label, id] of [
    ["a plain id", "canon-plain-1"],
    ["an id containing `/`, sent as `%2F`", "canon-slash/base"],
    ["an id containing `\\`, sent as `%5C`", "canon-back\\slash"],
    ["an id with a dot inside a segment", "canon.dotted.id"],
  ] as const) {
    it(`${label}: signed write, read and delete succeed`, async () => {
      const target = `/Memory/${encodeURIComponent(id)}`;

      const put = await signed("PUT", target, { id, agentId: agent.id, content: `body of ${id}`, durability: "standard" });
      expect(put.status, `PUT ${target} → ${put.status}: ${put.body.slice(0, 300)}`).toBeLessThan(300);

      const get = await signed("GET", target);
      expect(get.status, `GET ${target} → ${get.status}: ${get.body.slice(0, 300)}`).toBe(200);
      const row = JSON.parse(get.body);
      expect(row.id).toBe(id);
      expect(row.content).toBe(`body of ${id}`);

      const listed = await signed("GET", `/Memory/?agentId=${encodeURIComponent(agent.id)}`);
      expect(listed.status, `list → ${listed.status}: ${listed.body.slice(0, 300)}`).toBe(200);
      expect((JSON.parse(listed.body) as Array<{ id: string }>).some((r) => r.id === id)).toBe(true);

      const del = await signed("DELETE", target);
      expect(del.status, `DELETE ${target} → ${del.status}: ${del.body.slice(0, 300)}`).toBeLessThan(300);

      const gone = await signed("GET", target);
      expect(gone.status, `GET after delete ${target} → ${gone.status}`).toBe(404);
    }, 60_000);
  }

  it("the public /Health path still answers", async () => {
    const res = await rawRequest(harper.httpURL, "GET", "/Health");
    expect(res.status, `GET /Health → ${res.status}: ${res.body.slice(0, 200)}`).toBe(200);
  }, 30_000);
});

describe("a canonical Memory read is decided on the record Harper routes, not the raw path", () => {
  it("a `/Memory.json/<id>.content` target reads no record", async () => {
    const id = "canonmem-a";
    const secret = "canon-suffixed-collection-body";
    // The row is present and readable by its own address.
    const put = await signed("PUT", `/Memory/${encodeURIComponent(id)}`, { id, agentId: agent.id, content: secret, durability: "standard" });
    expect(put.status, `PUT → ${put.status}: ${put.body.slice(0, 200)}`).toBeLessThan(300);
    const own = await signed("GET", `/Memory/${encodeURIComponent(id)}`);
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body).content).toBe(secret);

    // The suffixed first segment routes to the Memory collection with no record
    // id, so this target addresses no record: it must not be rewritten into a
    // by-id read of the row the dot names.
    const got = await signed("GET", `/Memory.json/${id}.content`);
    expect(got.status, `GET /Memory.json/${id}.content → ${got.status}: ${got.body.slice(0, 200)}`).toBe(404);
    expect(got.body).not.toContain(secret);
  }, 30_000);
});
