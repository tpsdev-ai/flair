// Table subscriptions are served to administrators only.
//
// An exported table in the flair database has a subscription route — SSE
// (Accept: text/event-stream) and WebSocket on `/<Table>/` and `/<Table>/<id>`.
// That route admits administrators and trusted internal calls, and refuses
// everyone else: a verified non-admin agent gets 403 (WebSocket close 3003), a
// caller without a valid credential 401. Resources that are not tables, such
// as the feed resources, decide their own subscribers.
//
// The rule is checked four ways, on two Harpers (one per
// `authentication.authorizeLocal` setting) and on each Harper twice: before the
// least-privilege `flair-agent` Harper user is provisioned (verified agents then
// resolve to the shared admin Harper user) and after.
//   (a) ENUMERATION — every table in the flair database, read from the database
//       itself at runtime: on each table's collection route and by-id route
//       (a stored row's primary key when the table holds a row), a non-admin
//       subscriber is refused (or finds no route) on both transports and
//       receives nothing. A table added later is enumerated, and so checked,
//       without anyone naming it.
//   (b) The Memory, Message and MemoryUsage routes refuse a non-admin
//       subscriber and deliver nothing, including rows written after the
//       attempt; an anonymous subscriber gets 401.
//   (c) Administrators (Basic and an admin agent) still subscribe and receive rows.
//   (d) The feed resources are not table routes: FeedMemories and FeedSouls
//       serve a verified agent, and FeedMemories delivers none of A's private
//       memories.
//
// Mutation check: make the table guard admit every caller — every table whose
// own read gate admits the agent goes red in (a), and (b) goes red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

/**
 * Refuse to talk to anything but this test's own ephemeral instance: loopback,
 * the OS-assigned ports this instance was started on, never a production port,
 * and a data directory under the temp dir.
 */
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  const httpPort = Number(http.port);
  const opsPort = Number(ops.port);
  for (const [label, u, port] of [["http", http, httpPort], ["ops", ops, opsPort]] as const) {
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (httpPort === opsPort || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}

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

function basicAuth(harper: HarperInstance): string {
  return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
}

interface SubEvent { id: string; type: string; value: any }

function toEvent(obj: any): SubEvent | null {
  return obj && typeof obj === "object" && "id" in obj && "type" in obj && !String(obj.type).startsWith("error")
    ? { id: String(obj.id), type: String(obj.type), value: obj.value }
    : null;
}

/**
 * An SSE subscription attempt. Opening never blocks: a subscription that has
 * nothing to deliver may not send response headers until its first event, so
 * `status()` stays undefined until the server answers.
 */
function openSse(url: string, authorization?: string) {
  const ctrl = new AbortController();
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (authorization) headers.Authorization = authorization;
  let status: number | undefined;
  let raw = "";
  let text = "";
  const events: SubEvent[] = [];
  const parse = () => {
    let cut: number;
    while ((cut = raw.indexOf("\n\n")) >= 0) {
      const frame = raw.slice(0, cut);
      raw = raw.slice(cut + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!data) continue;
      try {
        const ev = toEvent(JSON.parse(data));
        if (ev) events.push(ev);
      } catch { /* non-JSON frame */ }
    }
  };
  const pump = (async () => {
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      status = res.status;
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        raw += chunk;
        text += chunk;
        parse();
      }
    } catch { /* aborted by stop() */ }
  })();
  return {
    status: () => status,
    /** Everything the server sent, including error frames. */
    text: () => text,
    events: () => events.slice(),
    /** The HTTP status, or undefined if the server has not answered within `ms`. */
    statusWithin: async (ms: number) => {
      const deadline = Date.now() + ms;
      while (status === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      return status;
    },
    waitFor: async (pred: (e: SubEvent) => boolean, what: string, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (events.some(pred)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${what}; status ${status}; received ${JSON.stringify(events.map((e) => [e.type, e.id]))}`);
    },
    stop: async () => { ctrl.abort(); await pump; },
  };
}

/** A WebSocket subscription attempt: whether it was closed (and how) within `ms`, and what it delivered. */
async function wsAttempt(url: string, authorization: string | undefined, ms: number, during?: () => Promise<void>) {
  const events: SubEvent[] = [];
  let closeCode: number | undefined;
  const ws = new WebSocket(url, (authorization ? { headers: { Authorization: authorization } } : {}) as any);
  ws.onmessage = (m: MessageEvent) => {
    try {
      const ev = toEvent(JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer)));
      if (ev) events.push(ev);
    } catch { /* non-JSON frame */ }
  };
  const closed = new Promise<void>((resolve) => { ws.onclose = (e: CloseEvent) => { closeCode = e.code; resolve(); }; });
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); resolve(); };
  });
  if (during) await during();
  await Promise.race([closed, new Promise((r) => setTimeout(r, ms))]);
  const result = { closeCode, events: events.slice() };
  try { ws.close(); } catch { /* already closed */ }
  return result;
}

const A = mkAgent("tsub-a"); // owns private rows
const B = mkAgent("tsub-b"); // verified non-admin subscriber, party to nothing of A's
const C = mkAgent("tsub-c"); // A's message recipient
const ADMIN = mkAgent("tsub-admin"); // an admin agent (role "admin")

// Paths that share a table's name but are served by a resource that is not the
// table: AgentReadPosition (resources/AgentReadPosition.ts) and the OAuth token
// endpoint (resources/OAuth.ts). Neither implements a subscription, so a
// subscriber there receives nothing.
const NOT_TABLE_ROUTES = new Set(["AgentReadPosition", "OAuthToken"]);

const HARPERS = [
  { name: "authorizeLocal on (harness default)", authorizeLocal: undefined, anonymousGetStatus: 403 },
  { name: "authorizeLocal off", authorizeLocal: "false", anonymousGetStatus: 401 },
] as const;

for (const config of HARPERS) {
  describe(`table subscriptions are served to administrators only — ${config.name}`, () => {
    let harper: HarperInstance;
    const tag = config.authorizeLocal ?? "default";
    // Every row id of A's that B must never receive, across all cases.
    const foreignIds = new Set<string>();

    async function adminOp(op: Record<string, any>): Promise<Response> {
      return fetch(harper.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicAuth(harper) },
        body: JSON.stringify(op),
      });
    }

    async function adminInsert(table: string, record: Record<string, unknown>): Promise<void> {
      const res = await adminOp({ operation: "upsert", database: "flair", table, records: [record] });
      const text = await res.text();
      expect(res.status, `insert into ${table} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    }

    async function writeMemory(agent: TestAgent, body: Record<string, unknown>): Promise<void> {
      const path = "/FeedMemories";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, ...body }),
      });
      const text = await res.text();
      expect(res.status, `memory write ${String(body.id)} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    }

    const now = () => new Date().toISOString();
    const sseAs = (agent: TestAgent, path: string) => openSse(`${harper.httpURL}${path}`, ed25519Header(agent, "GET", path));
    const wsUrl = (path: string) => `${harper.httpURL.replace(/^http/, "ws")}${path}`;

    /** Tables in the flair database and each table's primary-key attribute, read from the database itself. */
    async function flairTables(): Promise<Map<string, string | undefined>> {
      const res = await adminOp({ operation: "describe_database", database: "flair" });
      const body = await res.json();
      expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(200);
      return new Map(Object.keys(body).sort().map((t) => [t, typeof body[t]?.primary_key === "string" ? body[t].primary_key : undefined]));
    }

    /**
     * How `/<table>/` is served: "table" when an administrator's collection read
     * returns the table's rows (a JSON array), "other" when the path is served by
     * something that is not the table (a resource that shares its name), "none"
     * when there is no route.
     */
    async function routeKind(table: string): Promise<"table" | "other" | "none"> {
      const res = await fetch(`${harper.httpURL}/${table}/`, { headers: { Authorization: basicAuth(harper), Accept: "application/json" } });
      const text = await res.text();
      if (res.status === 404) return "none";
      if (res.status !== 200) return "other";
      try {
        return Array.isArray(JSON.parse(text)) ? "table" : "other";
      } catch {
        return "other";
      }
    }

    /**
     * A stored row's primary key, read from the table itself through the ops
     * API: the value of the attribute `describe_database` names as the table's
     * primary key. `key` is undefined when the table holds no row; a read that
     * fails, or a stored row without that value, is reported as `error`, never
     * as "no row".
     */
    async function storedKey(table: string, primaryKey: string | undefined): Promise<{ key?: string; error?: string }> {
      if (primaryKey === undefined) return { error: "describe_database names no primary key" };
      const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: primaryKey, search_value: "*", get_attributes: [primaryKey], limit: 1 });
      const text = await res.text();
      let rows: unknown;
      try { rows = JSON.parse(text); } catch { rows = undefined; }
      if (res.status !== 200 || !Array.isArray(rows)) return { error: `reading a stored key returned ${res.status}: ${text.slice(0, 200)}` };
      if (rows.length === 0) return {};
      const value = (rows[0] as any)?.[primaryKey];
      if ((typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value))) return { key: String(value) };
      return { error: `a stored row carries no value for the primary key ${primaryKey}` };
    }

    function cases(phase: string) {
      const p = `tsub-${tag}-${phase}`;
      const ids = {
        memory: `${p}-a-private-memory`,
        message: `${p}-a-to-c-message`,
        usage: `${A.id}:${p}-a-private-memory`,
        soul: `${A.id}:${p}-role`,
      };

      beforeAll(async () => {
        foreignIds.add(ids.memory);
        foreignIds.add(ids.message);
        foreignIds.add(ids.usage);
        await writeMemory(A, { id: ids.memory, content: `${p} a private`, visibility: "private" });
        await adminInsert("Message", { id: ids.message, from: A.id, to: C.id, threadId: `${p}-thread`, seq: 0, kind: "message", body: `${p} body for c only`, state: "delivered", createdAt: now() });
        await adminInsert("MemoryUsage", { id: ids.usage, agentId: A.id, memoryId: ids.memory, createdAt: now() });
        await adminInsert("Soul", { id: ids.soul, agentId: A.id, key: "role", value: `${p} role`, durability: "permanent", createdAt: now(), updatedAt: now() });
        // Rows in the two exported tables whose primary key is not `id`, so (a)
        // probes their by-id routes with a stored row's key.
        await adminInsert("Presence", { agentId: A.id, lastHeartbeatAt: Date.now(), activity: "idle" });
        await adminInsert("MemoryHostSource", { memoryId: ids.memory, hostSource: JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: `${p}-run` }), authorId: A.id, receivedAt: now() });
      }, 60_000);

      test("(a) every table in the database refuses a non-admin subscriber on its collection and by-id routes, over SSE and WebSocket", async () => {
        const primaryKeys = await flairTables();
        const tables = [...primaryKeys.keys()];
        const listable: string[] = []; // an administrator's collection read returns the table's rows
        const sampleKeys = new Map<string, string>(); // a stored row's primary key, when the table holds a row
        const found: string[] = [];
        for (const t of tables) {
          const kind = await routeKind(t);
          if (kind === "table") listable.push(t);
          const stored = await storedKey(t, primaryKeys.get(t));
          if (stored.key !== undefined) sampleKeys.set(t, stored.key);
          if (stored.error) found.push(`${t}: ${stored.error}`);
          if (kind === "other" && !NOT_TABLE_ROUTES.has(t)) {
            found.push(`${t}: /${t}/ is served by something that does not list the table's rows; if that is a resource that is not the table, add it to NOT_TABLE_ROUTES`);
          }
        }
        // Not vacuous: the enumeration reaches the routes this rule exists for,
        // and probes their by-id routes with a stored row's primary key.
        for (const t of ["Memory", "Message", "MemoryUsage"]) expect(listable, `${t} is listed by an administrator`).toContain(t);
        for (const t of ["Memory", "Message", "MemoryUsage", "Presence", "MemoryHostSource"]) {
          expect(sampleKeys.has(t), `${t}'s by-id route is probed with a stored row's primary key`).toBe(true);
        }

        for (const t of tables) {
          const byId = `/${t}/${encodeURIComponent(sampleKeys.get(t) ?? `absent-${randomUUID()}`)}`;
          for (const path of [`/${t}/`, byId]) {
            const sub = sseAs(B, path);
            const status = await sub.statusWithin(3_000);
            await sub.stop();
            const ws = await wsAttempt(wsUrl(path), ed25519Header(B, "GET", path), 2_000);
            if (sub.events().length > 0) found.push(`${path}: SSE delivered ${sub.events().length} rows`);
            if (ws.events.length > 0) found.push(`${path}: WebSocket delivered ${ws.events.length} rows`);
            if (NOT_TABLE_ROUTES.has(t)) continue; // not the table: it only has to deliver none of the table's rows
            // Refused (403 / close 3003) or no route at all (404 / close 1011).
            // A table an administrator can list has a route, so it must be refused.
            const refused = listable.includes(t) ? [403] : [403, 404];
            const closed = listable.includes(t) ? [3003] : [3003, 1011];
            if (!refused.includes(status as number)) found.push(`${path}: SSE ${status ?? "no answer in 3 s"}, expected ${refused.join(" or ")}`);
            if (!closed.includes(ws.closeCode as number)) found.push(`${path}: WebSocket close ${ws.closeCode ?? "none in 2 s"}, expected ${closed.join(" or ")}`);
          }
        }
        expect(found, `tables: ${tables.join(", ")}; listed by an administrator: ${listable.join(", ")}`).toEqual([]);
      }, 300_000);

      for (const [label, path, liveWrite] of [
        ["Memory", "/Memory/", async () => {
          const id = `${p}-a-private-live-${randomUUID()}`;
          foreignIds.add(id);
          await writeMemory(A, { id, content: `${p} live`, visibility: "private" });
        }],
        ["Memory by id", `/Memory/${ids.memory}`, async () => {
          await writeMemory(A, { id: ids.memory, content: `${p} a private v2`, visibility: "private" });
        }],
        ["Message", "/Message/", async () => {
          const id = `${p}-a-to-c-live-${randomUUID()}`;
          foreignIds.add(id);
          await adminInsert("Message", { id, from: A.id, to: C.id, threadId: `${p}-thread`, seq: 1, kind: "message", body: `${p} live body`, state: "delivered", createdAt: now() });
        }],
        ["MemoryUsage", "/MemoryUsage/", async () => {
          const id = `${A.id}:${p}-live-${randomUUID()}`;
          foreignIds.add(id);
          await adminInsert("MemoryUsage", { id, agentId: A.id, memoryId: `${p}-live`, createdAt: now() });
        }],
      ] as const) {
        test(`(b) ${label}: a non-admin subscriber is refused and receives nothing, over SSE and WebSocket`, async () => {
          const sub = sseAs(B, path);
          try {
            expect(await sub.statusWithin(5_000), `SSE ${path}`).toBe(403);
            await liveWrite();
            await new Promise((r) => setTimeout(r, 300));
            expect(sub.events().filter((e) => foreignIds.has(e.id)), `SSE ${path}`).toEqual([]);
          } finally {
            await sub.stop();
          }
          const ws = await wsAttempt(wsUrl(path), ed25519Header(B, "GET", path), 3_000, liveWrite);
          expect(ws.closeCode, `WebSocket ${path}`).toBe(3003);
          expect(ws.events.filter((e) => foreignIds.has(e.id)), `WebSocket ${path}`).toEqual([]);

          const anon = openSse(`${harper.httpURL}${path}`);
          try {
            expect(await anon.statusWithin(5_000), `anonymous SSE ${path}`).toBe(401);
            expect(anon.events()).toEqual([]);
          } finally {
            await anon.stop();
          }
          const anonWs = await wsAttempt(wsUrl(path), undefined, 3_000);
          expect(anonWs.closeCode, `anonymous WebSocket ${path}`).toBe(3000);
          expect(anonWs.events).toEqual([]);
        }, 60_000);
      }

      test("(c) an administrator still subscribes to table routes and receives rows (Basic and an admin agent)", async () => {
        for (const [path, id] of [["/Memory/", ids.memory], ["/Message/", ids.message], ["/MemoryUsage/", ids.usage]] as const) {
          const basic = openSse(`${harper.httpURL}${path}`, basicAuth(harper));
          try {
            await basic.waitFor((e) => e.id === id, `Basic admin receives ${id} on ${path}`);
            expect(basic.status()).toBe(200);
          } finally {
            await basic.stop();
          }
        }
        const agentSub = sseAs(ADMIN, "/Memory/");
        try {
          await agentSub.waitFor((e) => e.id === ids.memory, "the admin agent receives A's private memory");
          expect(agentSub.status()).toBe(200);
        } finally {
          await agentSub.stop();
        }
        const ws = await wsAttempt(wsUrl("/Memory/"), basicAuth(harper), 3_000);
        expect(ws.events.map((e) => e.id), "Basic admin over WebSocket").toContain(ids.memory);
      }, 60_000);

      test("(d) the feed resources are not table routes: FeedMemories and FeedSouls serve a verified agent", async () => {
        // FeedMemories admits a verified agent with either Harper user and
        // delivers the memories it can read: its own, and none of A's private ones.
        const own = `${p}-b-own`;
        const feed = sseAs(B, "/FeedMemories");
        try {
          await writeMemory(B, { id: own, content: `${p} b own`, visibility: "private" });
          const status = await feed.statusWithin(5_000);
          expect(feed.text(), "FeedMemories never answers with the table-route refusal").not.toContain("table subscriptions");
          expect(status, "FeedMemories admits a verified agent").toBe(200);
          await feed.waitFor((e) => e.id === own, "B's own memory on FeedMemories");
          expect(feed.events().filter((e) => foreignIds.has(e.id)), "FeedMemories delivers none of A's private memories").toEqual([]);
        } finally {
          await feed.stop();
        }
        // FeedSouls admits every verified agent.
        const souls = sseAs(B, "/FeedSouls");
        try {
          await souls.waitFor((e) => e.id === ids.soul, "a soul on FeedSouls");
          expect(souls.status()).toBe(200);
        } finally {
          await souls.stop();
        }
      }, 60_000);
    }

    beforeAll(async () => {
      // startHarper copies process.env into the spawned Harper's environment;
      // restore it immediately so no other file sees the override.
      const prior = process.env.AUTHENTICATION_AUTHORIZELOCAL;
      if (config.authorizeLocal === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
      else process.env.AUTHENTICATION_AUTHORIZELOCAL = config.authorizeLocal;
      try {
        harper = await startHarper();
        assertOwnInstance(harper);
      } finally {
        if (prior === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
        else process.env.AUTHENTICATION_AUTHORIZELOCAL = prior;
      }
      for (const [ag, role] of [[A, "agent"], [B, "agent"], [C, "agent"], [ADMIN, "admin"]] as const) {
        await adminInsert("Agent", { id: ag.id, name: ag.id, role, publicKey: ag.publicKey, createdAt: now() });
      }
    }, 180_000);

    afterAll(async () => {
      if (harper) await stopHarper(harper);
    }, 30_000);

    test(`the Harper under test runs with ${config.name}`, async () => {
      // An anonymous by-id read is refused either way; the status tells the two
      // settings apart (a forged loopback user is refused with 403, no user
      // with 401), so this pins that the setting took effect.
      const id = `tsub-calibration-${tag}`;
      foreignIds.add(id);
      await writeMemory(A, { id, content: "calibration", visibility: "private" });
      const res = await fetch(`${harper.httpURL}/Memory/${id}`);
      await res.arrayBuffer();
      expect(res.status).toBe(config.anonymousGetStatus);
    }, 30_000);

    describe("agents resolve to the shared admin Harper user", () => {
      cases("shared-user");
    });

    describe("agents resolve to the least-privilege flair-agent user", () => {
      beforeAll(async () => {
        await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
        await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
      }, 60_000);

      cases("flair-agent");
    });
  });
}
