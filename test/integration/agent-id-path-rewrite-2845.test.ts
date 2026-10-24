/**
 * agent-id-path-rewrite-2845.test.ts — a route that takes an agent id from its
 * path refuses an id Harper's path parsing changed, against a real Harper
 * (flair#2845).
 *
 * Harper reads `/<Route>/agent.json` (raw or with the dot encoded) as id
 * `agent`. Rows are seeded through the operations API for agent `agent`, for
 * a legacy agent id outside the agent-id rule, `agent.json`, and for the ids
 * the raw-target cases name (`agent#x`, `agent.json#x`, `#x`). A request
 * naming `agent.json` gets the named 400 `agent_id_rewritten`, naming both ids,
 * and none of `agent`'s rows; a request naming `agent` still gets them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

const AGENT = "agent";
const LEGACY = "agent.json";
const ISSUER = "https://flair.example.test";
const NOW = new Date().toISOString();

let h: HarperInstance;

const adminAuth = () => "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);
const encodeDots = (id: string) => encodeURIComponent(id).replace(/\./g, "%2E");
const FORMS = [["unencoded", LEGACY], ["encoded", encodeDots(LEGACY)]] as const;
// Ids seeded for the raw-target cases: a raw `#` stays in the id Harper passes.
const RAW_IDS = ["agent#x", "agent.json#x", "#x"];

function assertOwnInstance(inst: HarperInstance): void {
  for (const raw of [inst.httpURL, inst.opsURL]) {
    const u = new URL(raw);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!inst.process?.pid || !inst.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${inst.httpURL} is not an instance this test started`);
  }
}

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ database: "flair", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

const insert = (table: string, record: Record<string, unknown>) => ops({ operation: "insert", table, records: [record] });

async function rowById(table: string, id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_value", table, search_attribute: "id", search_value: id, get_attributes: ["*"] });
  return rows[0] ?? null;
}

async function send(path: string, opts: { method?: string; body?: unknown; anonymous?: boolean } = {}): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (!opts.anonymous) headers.Authorization = adminAuth();
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${h.httpURL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, text: await res.text() };
}

/** Undo HTTP/1.1 chunked transfer encoding. */
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
 * Send one request (as admin unless `anonymous`) over a raw socket with
 * `target` as the request target, byte for byte (fetch() and Bun's node:http
 * client can drop a raw `#` and the text after it before sending), and read
 * the whole response.
 */
function sendRaw(target: string, opts: { method?: string; body?: unknown; anonymous?: boolean } = {}): Promise<{ status: number; text: string }> {
  const { hostname, port } = new URL(h.httpURL);
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(Number(port), hostname);
    socket.setTimeout(15_000, () => socket.destroy(new Error(`raw ${method} ${target}: no response in 15 s`)));
    socket.on("connect", () => {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: ${hostname}:${port}`, "Connection: close"];
      if (!opts.anonymous) lines.push(`Authorization: ${adminAuth()}`);
      if (body !== undefined) lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body ?? ""}`);
    });
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`raw ${method} ${target}: no complete response (${all.length} bytes)`));
      const head = all.subarray(0, split).toString("latin1").split("\r\n");
      let rest: Buffer = all.subarray(split + 4);
      const length = head.find((l) => /^content-length:/i.test(l));
      if (head.some((l) => /^transfer-encoding:.*chunked/i.test(l))) rest = dechunk(rest);
      else if (length) rest = rest.subarray(0, Number(length.split(":")[1]!.trim()));
      resolve({ status: Number(head[0]!.split(" ")[1]), text: rest.toString("utf8") });
    });
  });
}

function expectRewrittenRefusal(res: { status: number; text: string }, label: string, requested = LEGACY): void {
  expect(res.status, `${label}: ${res.text.slice(0, 300)}`).toBe(400);
  const body = JSON.parse(res.text);
  expect(body.error, label).toBe("agent_id_rewritten");
  expect(body.requestedAgentId, label).toBe(requested);
  expect(body.receivedAgentId, label).toBe(AGENT);
}

beforeAll(async () => {
  h = await startHarper({ serverEnv: { FLAIR_MCP_ISSUER: ISSUER, FLAIR_PUBLIC_URL: undefined } });
  assertOwnInstance(h);
  for (const id of [AGENT, LEGACY, ...RAW_IDS]) {
    const publicKey = Buffer.from(nacl.sign.keyPair().publicKey).toString("base64");
    await insert("Agent", { id, name: `name-of-${id}`, role: "agent", publicKey, createdAt: NOW });
    await insert("WorkspaceState", { id: `ws-${id}`, agentId: id, ref: `ref-of-${id}`, provider: "git", timestamp: NOW, createdAt: NOW });
    await insert("AgentReadPosition", { id: `${id}:org-event`, agentId: id, stream: "org-event", position: `pos-of-${id}`, updatedAt: NOW });
    await insert("Message", { id: `msg-to-${id}`, from: "sender-x", to: id, state: "delivered", seq: 1, createdAt: NOW });
    await insert("Message", { id: `dead-from-${id}`, from: id, to: "recipient-x", state: "failed", failureReason: "deadline", seq: 1, createdAt: NOW });
  }
  for (const id of ["cand-agent-1", "cand-agent-2"]) {
    await insert("MemoryCandidate", { id, agentId: AGENT, claim: "agent's candidate", generatedAt: NOW, status: "pending" });
  }
  await insert("MemoryCandidate", { id: "cand-legacy-1", agentId: LEGACY, claim: "legacy candidate", generatedAt: NOW, status: "pending" });
  await insert("MemoryCandidate", { id: "cand-dotted-1", agentId: "agent.a", claim: "dotted candidate", generatedAt: NOW, status: "pending" });
  for (const [n, id] of RAW_IDS.entries()) {
    await insert("MemoryCandidate", { id: `cand-raw-${n}`, agentId: id, claim: `candidate of ${id}`, generatedAt: NOW, status: "pending" });
  }
}, 300_000);

afterAll(async () => {
  const dir = h?.installDir;
  await stopHarpers([h]);
  if (dir?.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS * 2);

describe("flair#2845 — GET /AdminMemoryCandidates/{agentId}", () => {
  test("a request naming agent.json is refused with agent_id_rewritten and carries none of agent's rows", async () => {
    for (const [form, segment] of FORMS) {
      const res = await send(`/AdminMemoryCandidates/${segment}`);
      expectRewrittenRefusal(res, form);
      expect(JSON.parse(res.text).candidates, `${form}: a refusal is not a listing`).toBeUndefined();
      expect(res.text, form).not.toContain("cand-agent-");
    }
  }, 60_000);

  test("every content-type extension Harper removes is refused, encoded and unencoded", async () => {
    for (const ext of ["json", "csv", "cbor", "msgpack"]) {
      for (const segment of [`${AGENT}.${ext}`, encodeDots(`${AGENT}.${ext}`)]) {
        expectRewrittenRefusal(await send(`/AdminMemoryCandidates/${segment}`), segment, `${AGENT}.${ext}`);
      }
    }
  }, 60_000);

  test("a request naming agent, or a dotted id Harper leaves whole, gets that agent's own rows", async () => {
    const own = await send(`/AdminMemoryCandidates/${AGENT}`);
    expect(own.status, own.text).toBe(200);
    expect(JSON.parse(own.text)).toEqual({ candidates: [{ id: "cand-agent-1" }, { id: "cand-agent-2" }], hasMore: false });
    for (const segment of ["agent.a", encodeDots("agent.a")]) {
      const dotted = await send(`/AdminMemoryCandidates/${segment}`);
      expect(dotted.status, dotted.text).toBe(200);
      expect(JSON.parse(dotted.text)).toEqual({ candidates: [{ id: "cand-dotted-1" }], hasMore: false });
    }
  }, 60_000);
});

describe("flair#2845 — the other routes that take an agent id from their path", () => {
  const reads: Array<{ route: string; marker: string; anonymous?: boolean }> = [
    { route: "WorkspaceLatest", marker: "ref-of-agent" },
    { route: "AgentReadPosition", marker: "pos-of-agent" },
    { route: "OrgEventCatchup", marker: "pos-of-agent" },
    { route: "MessageInbox", marker: "msg-to-agent" },
    { route: "MessageDeadLetter", marker: "dead-from-agent" },
    { route: "AgentCard", marker: "name-of-agent", anonymous: true },
    { route: "MCPClientMetadata", marker: `${ISSUER}/MCPClientMetadata/agent`, anonymous: true },
  ];

  for (const { route, marker, anonymous } of reads) {
    test(`GET /${route}: agent.json is refused with agent_id_rewritten; agent is answered`, async () => {
      const own = await send(`/${route}/${AGENT}`, { anonymous });
      expect(own.status, `${route} own: ${own.text.slice(0, 300)}`).toBe(200);
      expect(own.text, `${route} own`).toContain(marker);
      for (const [form, segment] of FORMS) {
        const res = await send(`/${route}/${segment}`, { anonymous });
        expectRewrittenRefusal(res, `${route} ${form}`);
        expect(res.text, `${route} ${form}`).not.toContain(marker);
      }
    }, 60_000);
  }

  for (const route of ["AgentReadPosition", "OrgEventCatchup"]) {
    test(`POST /${route}: agent.json is refused with agent_id_rewritten and agent's position is unchanged`, async () => {
      const before = await rowById("AgentReadPosition", `${AGENT}:org-event`);
      expect(before?.position).toBe("pos-of-agent");
      for (const [form, segment] of FORMS) {
        const res = await send(`/${route}/${segment}`, { method: "POST", body: { stream: "org-event", position: "pos-zz-advanced" } });
        expectRewrittenRefusal(res, `${route} ${form}`);
      }
      expect(await rowById("AgentReadPosition", `${AGENT}:org-event`)).toEqual(before);
      expect((await rowById("AgentReadPosition", `${LEGACY}:org-event`))?.position).toBe("pos-of-agent.json");
    }, 60_000);
  }
});

describe("flair#2845 — raw request targets, sent byte for byte", () => {
  // What Harper 5.3.1 passes the route for each raw segment (see the unit file):
  // a raw `#` does not end Harper's path, so the text after the first dot is
  // `json#x` for `agent.json#x` (not a content type: kept whole) and `json` for
  // `agent#x.json` (removed). Harper's extension lookup also matches names
  // inherited from Object.prototype, so `agent.constructor` reaches the route
  // as `agent`.
  const KEPT = ["agent#x", "agent.json#x"];
  const REWRITTEN: Array<[segment: string, received: string]> = [
    ["#x.json", "#x"],
    ["agent#x.json", "agent#x"],
    ["agent.constructor", AGENT],
    ["agent.toString", AGENT],
  ];
  const routes: Array<{ route: string; marker: (id: string) => string; anonymous?: boolean }> = [
    { route: "AdminMemoryCandidates", marker: (id) => (id === AGENT ? "cand-agent-1" : `cand-raw-${RAW_IDS.indexOf(id)}`) },
    { route: "WorkspaceLatest", marker: (id) => `ref-of-${id}` },
    { route: "AgentReadPosition", marker: (id) => `pos-of-${id}` },
    { route: "OrgEventCatchup", marker: (id) => `pos-of-${id}` },
    { route: "MessageInbox", marker: (id) => `msg-to-${id}` },
    { route: "MessageDeadLetter", marker: (id) => `dead-from-${id}` },
    { route: "AgentCard", marker: (id) => `name-of-${id}`, anonymous: true },
    { route: "MCPClientMetadata", marker: (id) => `${ISSUER}/MCPClientMetadata/${id}`, anonymous: true },
  ];

  for (const { route, marker, anonymous } of routes) {
    test(`GET /${route}: a raw # Harper keeps in the id is answered as for the encoded id`, async () => {
      for (const id of KEPT) {
        const raw = await sendRaw(`/${route}/${id}`, { anonymous });
        const encoded = await send(`/${route}/${encodeURIComponent(id)}`, { anonymous });
        expect(raw.status, `${route} ${id}: ${raw.text.slice(0, 300)}`).toBe(200);
        expect(raw.text, `${route} ${id}`).toContain(marker(id));
        expect(raw, `${route} ${id}`).toEqual(encoded);
      }
    }, 60_000);

    test(`GET /${route}: a raw target Harper rewrites is refused with agent_id_rewritten`, async () => {
      for (const [segment, received] of REWRITTEN) {
        const res = await sendRaw(`/${route}/${segment}`, { anonymous });
        expect(res.status, `${route} ${segment}: ${res.text.slice(0, 300)}`).toBe(400);
        const body = JSON.parse(res.text);
        expect(body.error, `${route} ${segment}`).toBe("agent_id_rewritten");
        expect(body.requestedAgentId, `${route} ${segment}`).toBe(segment);
        expect(body.receivedAgentId, `${route} ${segment}`).toBe(received);
        expect(res.text, `${route} ${segment}`).not.toContain(marker(received));
      }
    }, 60_000);
  }

  for (const route of ["AgentReadPosition", "OrgEventCatchup"]) {
    test(`POST /${route}: a raw rewritten target advances no position; a kept one advances its own`, async () => {
      const ids = [AGENT, "agent#x", "#x"];
      const before = new Map<string, any>();
      for (const id of ids) before.set(id, await rowById("AgentReadPosition", `${id}:org-event`));
      for (const [segment, received] of REWRITTEN) {
        const res = await sendRaw(`/${route}/${segment}`, { method: "POST", body: { stream: "org-event", position: "pos-zz-advanced" } });
        expect(res.status, `${route} ${segment}: ${res.text.slice(0, 300)}`).toBe(400);
        expect(JSON.parse(res.text), `${route} ${segment}`).toMatchObject({ error: "agent_id_rewritten", requestedAgentId: segment, receivedAgentId: received });
      }
      for (const id of ids) expect(await rowById("AgentReadPosition", `${id}:org-event`), `${route} ${id}`).toEqual(before.get(id));

      const kept = await sendRaw(`/${route}/agent.json#x`, { method: "POST", body: { stream: "org-event", position: "pos-zz-advanced" } });
      expect(kept.status, `${route} agent.json#x: ${kept.text.slice(0, 300)}`).toBe(200);
      expect((await rowById("AgentReadPosition", "agent.json#x:org-event"))?.position, route).toBe("pos-zz-advanced");
    }, 60_000);
  }
});
