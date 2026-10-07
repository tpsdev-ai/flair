// Feed subscriptions apply the subscriber's read scope.
//
// FeedMemories and FeedSouls stream table events to a subscriber (SSE here;
// WebSocket uses the same connect()). What a subscriber receives must follow the
// SAME rule as the ordinary read path for that table:
//   - Memory: resolveReadScope(reader).isAllowed(record) — the reader's own
//     records at any visibility, plus every other agent's non-private records
//     (the rule Memory.get()/search() apply). Admin and internal subscribers are
//     unfiltered.
//   - Soul: any verified agent reads every soul (Soul has no per-record scope),
//     anonymous callers read nothing.
//
// Each memory case runs twice: once before the least-privilege `flair-agent`
// Harper user is provisioned (verified agents then resolve to the shared admin
// Harper user) and once after (agents resolve to `flair-agent`). The scope a
// subscriber receives must not depend on which Harper user the agent resolved
// to. The parity checks compare the feed against the by-id read path directly
// (GET /Memory/<id>, GET /Soul/<id> as the same agent), so the test measures
// "same rule as the read path" rather than restating the rule.
//
// Mutation check: make FeedMemories.connect() deliver the table subscription
// unfiltered to a non-admin agent — the "never receives another agent's
// private record" cases fail.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { readStatusUntil } from "../helpers/read-status-until";

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

function basicAuth(harper: HarperInstance): string {
  return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth(harper) },
    body: JSON.stringify(op),
  });
}

interface FeedEvent { id: string; type: string; value: any }

/** An open SSE subscription. Frames are parsed as they arrive. */
interface Feed {
  status: number;
  events: () => FeedEvent[];
  waitFor: (pred: (e: FeedEvent) => boolean, what: string, timeoutMs?: number) => Promise<void>;
  stop: () => Promise<void>;
}

async function openFeed(url: string, authorization?: string): Promise<Feed> {
  const ctrl = new AbortController();
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (authorization) headers.Authorization = authorization;
  const res = await fetch(url, { headers, signal: ctrl.signal });
  let raw = "";
  const parsed: FeedEvent[] = [];
  const parse = () => {
    let cut: number;
    while ((cut = raw.indexOf("\n\n")) >= 0) {
      const frame = raw.slice(0, cut);
      raw = raw.slice(cut + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!data) continue;
      try {
        const obj = JSON.parse(data);
        if (obj && typeof obj === "object" && "id" in obj) parsed.push({ id: String(obj.id), type: String(obj.type), value: obj.value });
      } catch { /* non-JSON frame */ }
    }
  };
  let pump: Promise<void> = Promise.resolve();
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
          parse();
        }
      } catch { /* aborted by stop() */ }
    })();
  } else {
    raw = await res.text();
    parse();
  }
  return {
    status: res.status,
    events: () => parsed.slice(),
    waitFor: async (pred, what, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (parsed.some(pred)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${what}; received: ${JSON.stringify(parsed.map((e) => [e.type, e.id]))}`);
    },
    stop: async () => { ctrl.abort(); await pump; },
  };
}

/**
 * Open an SSE subscription without waiting for its response headers. Harper
 * sends an SSE response's headers with its first event, so a subscription
 * that has nothing to deliver never resolves `fetch`. Frames are collected if
 * and when they arrive; `stop()` aborts the request.
 */
function openFeedUnawaited(url: string, authorization: string): { events: () => FeedEvent[]; stop: () => Promise<void> } {
  const ctrl = new AbortController();
  const parsed: FeedEvent[] = [];
  const pump = (async () => {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream", Authorization: authorization }, signal: ctrl.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let raw = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = raw.indexOf("\n\n")) >= 0) {
          const data = raw.slice(0, cut).split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          raw = raw.slice(cut + 2);
          if (!data) continue;
          try {
            const obj = JSON.parse(data);
            if (obj && typeof obj === "object" && "id" in obj) parsed.push({ id: String(obj.id), type: String(obj.type), value: obj.value });
          } catch { /* non-JSON frame */ }
        }
      }
    } catch { /* aborted by stop() */ }
  })();
  return { events: () => parsed.slice(), stop: async () => { ctrl.abort(); await pump; } };
}

let harper: HarperInstance;
const A = mkAgent("feedscope-a");
const B = mkAgent("feedscope-b");
// Every A-private memory id created by any case: none may ever reach B.
const aPrivateIds = new Set<string>();

async function feedWrite(agent: TestAgent, body: Record<string, unknown>): Promise<void> {
  const path = "/FeedMemories";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: agent.id, ...body }),
  });
  const text = await res.text();
  expect(res.status, `feed write ${String(body.id)} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
}

async function readStatus(agent: TestAgent, path: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: ed25519Header(agent, "GET", path) }, signal });
  await res.arrayBuffer();
  return res.status;
}

async function openAs(agent: TestAgent, path: string): Promise<Feed> {
  return openFeed(`${harper.httpURL}${path}`, ed25519Header(agent, "GET", path));
}

function memoryFeedCases(phase: string) {
  const p = `feedscope-${phase}`;
  const ids = {
    aPrivate: `${p}-a-private`,
    aShared: `${p}-a-shared`,
    aUnset: `${p}-a-unset`, // no visibility field: reads as org-open
    bOwn: `${p}-b-own`, // B's own PRIVATE record
  };

  beforeAll(async () => {
    aPrivateIds.add(ids.aPrivate);
    await feedWrite(A, { id: ids.aPrivate, content: `${p} a private v1`, visibility: "private" });
    await feedWrite(A, { id: ids.aShared, content: `${p} a shared v1`, visibility: "shared" });
    await feedWrite(A, { id: ids.aUnset, content: `${p} a unset v1` });
    await feedWrite(B, { id: ids.bOwn, content: `${p} b own v1`, visibility: "private" });
  }, 60_000);

  test("replay at subscribe: B receives its own record and A's org-visible records, never A's private record", async () => {
    const feed = await openAs(B, "/FeedMemories");
    try {
      expect(feed.status, "a verified agent may subscribe to the memory feed").toBe(200);
      // Replay precedes live delivery: once B's post-subscribe write arrives,
      // the subscribe-time replay is complete.
      const sentinel = `${p}-b-replay-sentinel`;
      await feedWrite(B, { id: sentinel, content: `${p} b sentinel`, visibility: "private" });
      await feed.waitFor((e) => e.id === sentinel, "B's sentinel");

      const got = new Set(feed.events().map((e) => e.id));
      expect(got.has(ids.bOwn), "B's own private record").toBe(true);
      expect(got.has(ids.aShared), "A's shared record").toBe(true);
      expect(got.has(ids.aUnset), "A's record with no visibility field").toBe(true);
      const leaked = feed.events().filter((e) => aPrivateIds.has(e.id));
      expect(leaked, "A's private records must never reach B").toEqual([]);
    } finally {
      await feed.stop();
    }
  }, 30_000);

  test("replay withholds a closed skill after its successor expires", async () => {
    const root = `${p}-expired-skill-root`;
    const body = { id: root, content: "skill v1", trigger: "when assigned", tags: ["skill"], durability: "persistent", visibility: "shared" };
    await feedWrite(A, body);
    await feedWrite(A, { ...body, content: "skill v2" });
    const query = await adminOp(harper, { operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "skillSubjectId", search_value: root, get_attributes: ["*"] });
    expect(query.status).toBe(200);
    const heads = (await query.json() as any[]).filter((row) => !row.validTo && row.archived !== true);
    expect(heads).toHaveLength(1);
    expect(await readStatus(B, `/Memory/${root}`)).toBe(200);
    const before = await openAs(B, "/FeedMemories");
    try {
      const sentinel = `${p}-expiry-before`;
      await feedWrite(B, { id: sentinel, content: `${p} before expiry` });
      await before.waitFor((e) => e.id === sentinel, "before-expiry sentinel");
      expect(before.events().map((e) => e.id)).toContain(root);
    } finally {
      await before.stop();
    }
    const expired = await adminOp(harper, { operation: "upsert", database: "flair", table: "Memory", records: [{ ...heads[0], expiresAt: "2020-01-01T00:00:00.000Z" }] });
    expect(expired.status).toBe(200);
    await expired.arrayBuffer();
    // The observed post-upsert 200 may reflect cross-thread read visibility; the mechanism and duration have not been measured.
    expect(await readStatusUntil((signal) => readStatus(B, `/Memory/${root}`, signal), 404, 200)).toBe(404);
    const after = await openAs(B, "/FeedMemories");
    try {
      const sentinel = `${p}-expiry-after`;
      await feedWrite(B, { id: sentinel, content: `${p} after expiry` });
      await after.waitFor((e) => e.id === sentinel, "after-expiry sentinel");
      expect(after.events().map((e) => e.id)).not.toContain(root);
    } finally {
      await after.stop();
    }
  }, 120_000);

  test("live updates: B receives changes to A's org-visible record, never to A's private records", async () => {
    const feed = await openAs(B, "/FeedMemories");
    try {
      expect(feed.status).toBe(200);
      const sentinel = `${p}-b-live-sentinel`;
      await feedWrite(B, { id: sentinel, content: `${p} b live sentinel`, visibility: "private" });
      await feed.waitFor((e) => e.id === sentinel, "B's sentinel");

      // Private writes FIRST, then the shared update: events arrive in commit
      // order, so once the shared update is here any private event would be too.
      const aPrivateNew = `${p}-a-private-live`;
      aPrivateIds.add(aPrivateNew);
      await feedWrite(A, { id: ids.aPrivate, content: `${p} a private v2`, visibility: "private" });
      await feedWrite(A, { id: aPrivateNew, content: `${p} a private live`, visibility: "private" });
      await feedWrite(A, { id: ids.aShared, content: `${p} a shared v2`, visibility: "shared" });
      await feed.waitFor((e) => e.id === ids.aShared && e.value?.content === `${p} a shared v2`, "A's shared update");

      const leaked = feed.events().filter((e) => aPrivateIds.has(e.id));
      expect(leaked, "A's private records must never reach B").toEqual([]);
    } finally {
      await feed.stop();
    }
  }, 30_000);

  test("delete of A's private record is not announced to B", async () => {
    const feed = await openAs(B, "/FeedMemories");
    try {
      expect(feed.status).toBe(200);
      const doomed = `${p}-a-private-doomed`;
      aPrivateIds.add(doomed);
      await feedWrite(A, { id: doomed, content: `${p} a private doomed`, visibility: "private" });
      const delPath = `/Memory/${doomed}`;
      const del = await fetch(`${harper.httpURL}${delPath}`, {
        method: "DELETE",
        headers: { Authorization: ed25519Header(A, "DELETE", delPath) },
      });
      await del.arrayBuffer();
      expect(del.status, `A deleting its own record returned ${del.status}`).toBeLessThan(300);
      const after = `${p}-a-shared-after-delete`;
      await feedWrite(A, { id: after, content: `${p} a shared after delete`, visibility: "shared" });
      await feed.waitFor((e) => e.id === after, "A's shared write after the delete");

      const leaked = feed.events().filter((e) => aPrivateIds.has(e.id));
      expect(leaked, "no event of any type for A's private records").toEqual([]);
    } finally {
      await feed.stop();
    }
  }, 30_000);

  test("parity: the feed delivers exactly the records B's by-id read returns", async () => {
    const feed = await openAs(B, "/FeedMemories");
    try {
      expect(feed.status).toBe(200);
      const sentinel = `${p}-b-parity-sentinel`;
      await feedWrite(B, { id: sentinel, content: `${p} b parity sentinel`, visibility: "private" });
      await feed.waitFor((e) => e.id === sentinel, "B's sentinel");
      const got = new Set(feed.events().map((e) => e.id));
      for (const id of Object.values(ids)) {
        const status = await readStatus(B, `/Memory/${id}`);
        expect([200, 404], `GET /Memory/${id} as B returned ${status}`).toContain(status);
        expect(got.has(id), `${id}: feed delivery must match the read path (GET ${status})`).toBe(status === 200);
      }
    } finally {
      await feed.stop();
    }
  }, 30_000);

  test("a by-id subscription receives only that record's events", async () => {
    const sharedFeed = await openAs(B, `/FeedMemories/${ids.aShared}`);
    const privatePath = `/FeedMemories/${ids.aPrivate}`;
    // Nothing is deliverable on this subscription, so its headers never arrive.
    const privateFeed = openFeedUnawaited(`${harper.httpURL}${privatePath}`, ed25519Header(B, "GET", privatePath));
    try {
      expect(sharedFeed.status).toBe(200);
      // A readable record with another id changes first, then A's private
      // record, then the subscribed record.
      await feedWrite(B, { id: ids.bOwn, content: `${p} b own by-id`, visibility: "private" });
      await feedWrite(A, { id: ids.aPrivate, content: `${p} a private by-id`, visibility: "private" });
      await feedWrite(A, { id: ids.aShared, content: `${p} a shared by-id`, visibility: "shared" });
      await sharedFeed.waitFor(
        (e) => e.id === ids.aShared && e.value?.content === `${p} a shared by-id`,
        "the subscribed record's update",
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(sharedFeed.events().filter((e) => e.id !== ids.aShared), "events for any other id").toEqual([]);
      expect(privateFeed.events(), "a by-id subscription to A's private record").toEqual([]);
    } finally {
      await sharedFeed.stop();
      await privateFeed.stop();
    }
  }, 30_000);

  test("WebSocket: B receives its own and A's org-visible records, never A's private records", async () => {
    const path = "/FeedMemories";
    const received: FeedEvent[] = [];
    const ws = new WebSocket(`${harper.httpURL.replace(/^http/, "ws")}${path}`, {
      headers: { Authorization: ed25519Header(B, "GET", path) },
    } as any);
    ws.onmessage = (m: MessageEvent) => {
      try {
        const obj = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer));
        if (obj && typeof obj === "object" && "id" in obj) received.push({ id: String(obj.id), type: String(obj.type), value: obj.value });
      } catch { /* non-JSON frame */ }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("WebSocket did not open")), 10_000);
        ws.onopen = () => { clearTimeout(t); resolve(); };
        ws.onerror = () => { clearTimeout(t); reject(new Error("WebSocket error before open")); };
      });
      const sentinel = `${p}-b-ws-sentinel`;
      await feedWrite(B, { id: sentinel, content: `${p} b ws sentinel`, visibility: "private" });
      const deadline = Date.now() + 10_000;
      while (!received.some((e) => e.id === sentinel)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for the sentinel; received: ${JSON.stringify(received.map((e) => [e.type, e.id]))}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const got = new Set(received.map((e) => e.id));
      expect(got.has(ids.bOwn), "B's own private record").toBe(true);
      expect(got.has(ids.aShared), "A's shared record").toBe(true);
      expect(received.filter((e) => aPrivateIds.has(e.id)), "A's private records must never reach B").toEqual([]);
    } finally {
      ws.close();
    }
  }, 30_000);

  test("an admin subscriber is unfiltered", async () => {
    const feed = await openFeed(`${harper.httpURL}/FeedMemories`, basicAuth(harper));
    try {
      expect(feed.status).toBe(200);
      const sentinel = `${p}-admin-sentinel`;
      await feedWrite(B, { id: sentinel, content: `${p} admin sentinel`, visibility: "private" });
      await feed.waitFor((e) => e.id === sentinel, "B's sentinel");
      const got = new Set(feed.events().map((e) => e.id));
      for (const id of Object.values(ids)) expect(got.has(id), `admin receives ${id}`).toBe(true);
    } finally {
      await feed.stop();
    }
  }, 30_000);
}

describe("feed subscriptions apply the subscriber's read scope", () => {
  beforeAll(async () => {
    harper = await startHarper();
    for (const ag of [A, B]) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: ag.id, name: ag.id, role: "agent", publicKey: ag.publicKey, createdAt: new Date().toISOString() }],
      });
      expect(res.status).toBe(200);
    }
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  describe("memory feed — agents resolve to the shared admin Harper user", () => {
    memoryFeedCases("shared-user");

    test("an anonymous subscriber is refused and receives nothing", async () => {
      const feed = await openFeed(`${harper.httpURL}/FeedMemories`);
      try {
        expect([401, 403], `anonymous subscribe returned ${feed.status}`).toContain(feed.status);
        expect(feed.events()).toEqual([]);
      } finally {
        await feed.stop();
      }
    }, 30_000);
  });

  describe("memory feed — agents resolve to the least-privilege flair-agent user", () => {
    beforeAll(async () => {
      await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
      await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
    }, 60_000);

    memoryFeedCases("flair-agent");
  });

  describe("soul feed follows the Soul read rule", () => {
    const now = () => new Date().toISOString();
    async function upsertSoul(agentId: string, key: string, value: string): Promise<string> {
      const id = `${agentId}:${key}`;
      const res = await adminOp(harper, {
        operation: "upsert", database: "flair", table: "Soul",
        records: [{ id, agentId, key, value, durability: "permanent", createdAt: now(), updatedAt: now() }],
      });
      expect(res.status, `soul upsert ${id} returned ${res.status}`).toBe(200);
      return id;
    }

    test("replay and live update: B's soul feed matches B's by-id Soul reads", async () => {
      const aSoul = await upsertSoul(A.id, "role", "a role v1");
      const bSoul = await upsertSoul(B.id, "role", "b role v1");
      const feed = await openAs(B, "/FeedSouls");
      try {
        expect(feed.status).toBe(200);
        const sentinel = await upsertSoul(B.id, "sentinel", "b sentinel");
        await feed.waitFor((e) => e.id === sentinel, "B's soul sentinel");
        const got = new Set(feed.events().map((e) => e.id));
        for (const id of [aSoul, bSoul]) {
          const status = await readStatus(B, `/Soul/${encodeURIComponent(id)}`);
          expect([200, 404], `GET /Soul/${id} as B returned ${status}`).toContain(status);
          expect(got.has(id), `${id}: feed delivery must match the read path (GET ${status})`).toBe(status === 200);
        }

        await upsertSoul(A.id, "role", "a role v2");
        const readable = (await readStatus(B, `/Soul/${encodeURIComponent(aSoul)}`)) === 200;
        if (readable) {
          await feed.waitFor((e) => e.id === aSoul && e.value?.value === "a role v2", "A's soul update");
        } else {
          const after = await upsertSoul(B.id, "after", "b after");
          await feed.waitFor((e) => e.id === after, "B's soul write after the update");
          expect(feed.events().filter((e) => e.id === aSoul)).toEqual([]);
        }
      } finally {
        await feed.stop();
      }
    }, 30_000);

    test("an anonymous soul subscriber is refused and receives nothing", async () => {
      const feed = await openFeed(`${harper.httpURL}/FeedSouls`);
      try {
        expect([401, 403], `anonymous subscribe returned ${feed.status}`).toContain(feed.status);
        expect(feed.events()).toEqual([]);
      } finally {
        await feed.stop();
      }
    }, 30_000);
  });
});
