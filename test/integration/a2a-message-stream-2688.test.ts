/**
 * a2a-message-stream-2688.test.ts — A2A `message/stream` against a real Harper.
 *
 * `message/stream` answers with a Server-Sent Events stream of the OrgEvents
 * for params.agentId, read in process through OrgEventCatchup with the
 * requesting caller's own identity. A non-admin caller may name only its own
 * agent id (message/send's caller-match rule; an admin may name another
 * agent), and the polling stops when the client disconnects.
 *
 * Harper runs a private composed copy of the built component with one added
 * test module (test/fixtures/catchup-read-probe-2688/probe.js) that records
 * every OrgEventCatchup read: the participant, the identity the read's context
 * carried, whether that context came from an HTTP request, and when it ran.
 * The probe is how the cases observe which context the stream reads with and
 * that no read starts after the client is gone.
 *
 * Mutations (each fails a named case):
 *   - read the catch-up through an unauthenticated HTTP self-request
 *       → "delivers an OrgEvent targeted at the caller ..."
 *   - drop the agentId == caller check from message/stream
 *       → "a request naming another agent is refused ..."
 *   - read with an admin or internal context instead of the caller's
 *       → "an event targeted at another agent never reaches the stream ..."
 *   - add a discarded read of another agent's catch-up to each poll
 *       → "an event targeted at another agent never reaches the stream ..."
 *   - leave the poll running after the client closes
 *       → "after the client disconnects no further catch-up read runs ..."
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { CATCHUP_READ_PROBE, componentWithReplayProbe, type ProbeComponent } from "../helpers/component-with-replay-probe";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let harper: HarperInstance;
let composed: ProbeComponent;

const A = mkAgent("a2astream-a");
const B = mkAgent("a2astream-b");
const P = mkAgent("a2astream-pub");
const E = mkAgent("a2astream-e");
const D = mkAgent("a2astream-d");

/** The stream's poll interval (resources/a2a-stream.ts A2A_STREAM_POLL_MS). */
const POLL_MS = 2000;

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function seedAgent(agent: TestAgent): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent ${agent.id} returned ${res.status}`).toBe(200);
}

/** Publish an OrgEvent as `author` through the REST resource. */
async function publishEvent(author: TestAgent, ev: { id: string; targetIds: string[]; summary: string }): Promise<void> {
  const path = `/OrgEvent/${ev.id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(author, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({
      id: ev.id, authorId: author.id, kind: "a2a-stream-test", summary: ev.summary,
      targetIds: ev.targetIds, createdAt: new Date().toISOString(),
    }),
  });
  expect(res.status, `publish ${ev.id} returned ${res.status}: ${(await res.text()).slice(0, 300)}`).toBeLessThan(300);
}

interface Frame { event: string | null; data: any }

/** A POST /a2a whose body is read as it arrives, for a bounded time. */
interface RpcStream {
  status: number;
  contentType: string;
  raw: () => string;
  frames: () => Frame[];
  ended: () => boolean;
  waitFor: (pred: (f: Frame) => boolean, what: string, timeoutMs?: number) => Promise<Frame>;
  close: () => Promise<void>;
}

let rpcSeq = 0;

async function postA2A(agent: TestAgent | null, method: string, params: Record<string, unknown>): Promise<{ rpcId: number; stream: RpcStream }> {
  const rpcId = ++rpcSeq;
  const ctrl = new AbortController();
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (agent) headers.Authorization = ed25519Header(agent, "POST", "/a2a");
  const res = await fetch(`${harper.httpURL}/a2a`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    signal: ctrl.signal,
  });
  let raw = "";
  let ended = false;
  const pump = (async () => {
    if (!res.body) { ended = true; return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
      }
      ended = true;
    } catch { /* aborted by close() */ }
  })();
  const frames = (): Frame[] => raw
    .split("\n\n")
    .filter((block) => block.includes("data: "))
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? null;
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      try { return { event, data: JSON.parse(data) }; } catch { return { event, data: null }; }
    });
  return {
    rpcId,
    stream: {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      raw: () => raw,
      frames,
      ended: () => ended,
      waitFor: async (pred, what, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const hit = frames().find(pred);
          if (hit) return hit;
          await sleep(50);
        }
        throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; received: ${raw.slice(0, 2000)}`);
      },
      close: async () => {
        ctrl.abort();
        await Promise.race([pump, sleep(5_000)]);
      },
    },
  };
}

/** Read a JSON-RPC answer that is expected to be a plain JSON body (bounded). */
async function settle(stream: RpcStream, ms = 4_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (!stream.ended() && Date.now() < deadline) await sleep(25);
  await stream.close();
  return stream.raw();
}

interface ProbeRead { participantId: string | null; tpsAgent: string | null; tpsAgentIsAdmin: boolean; http: boolean; at: number }

function probeReads(): ProbeRead[] {
  const file = join(harper.installDir, CATCHUP_READ_PROBE.out, "reads.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function readsFor(participantId: string): ProbeRead[] {
  return probeReads().filter((r) => r.participantId === participantId);
}

async function waitForReads(participantId: string, count: number, timeoutMs = 15_000): Promise<ProbeRead[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reads = readsFor(participantId);
    if (reads.length >= count) return reads;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${count} catch-up reads for ${participantId}; saw ${readsFor(participantId).length}`);
}

/** Base64 / base64url spellings of `marker` at each of the three byte alignments. */
function base64Spellings(marker: string): string[] {
  const out = new Set<string>();
  for (const pad of ["", "x", "xx"]) {
    const enc = Buffer.from(pad + marker, "utf8").toString("base64");
    // Drop the characters that depend on the pad prefix or the bytes after the marker.
    const start = pad.length === 0 ? 0 : pad.length === 1 ? 2 : 3;
    const core = enc.slice(start, enc.length - 4);
    if (core.length >= 8) {
      out.add(core);
      out.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...out];
}

/** Does `received` carry `marker` as text, as base64 / base64url text, or inside any decodable base64 run? */
function carriesMarker(received: string, marker: string): boolean {
  if (received.includes(marker)) return true;
  if (base64Spellings(marker).some((s) => received.includes(s))) return true;
  for (const run of received.match(/[A-Za-z0-9+/_-]{12,}={0,2}/g) ?? []) {
    for (const variant of [run, run.replace(/-/g, "+").replace(/_/g, "/")]) {
      try {
        if (Buffer.from(variant, "base64").toString("utf8").includes(marker)) return true;
      } catch { /* not base64 */ }
    }
  }
  return false;
}

const SSE_EVENT_LINE = /^(event|data):/m;

beforeAll(async () => {
  composed = componentWithReplayProbe({ probe: CATCHUP_READ_PROBE });
  harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
  assertOwnInstance(harper);
  for (const agent of [A, B, P, E, D]) await seedAgent(agent);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  composed?.cleanup();
}, HARPER_STOP_BUDGET_MS + 10_000);

describe("A2A message/stream delivers the OrgEvents for the named agent", () => {
  it("delivers an OrgEvent targeted at the caller, published after the stream opens, as an org.event frame", async () => {
    const { rpcId, stream } = await postA2A(A, "message/stream", { agentId: A.id });
    try {
      expect(stream.status).toBe(200);
      expect(stream.contentType).toStartWith("text/event-stream");

      const eventId = `a2688-for-a-${randomUUID()}`;
      const marker = `marker-for-a-${randomUUID()}`;
      await publishEvent(P, { id: eventId, targetIds: [A.id], summary: `note ${marker}` });

      const frame = await stream.waitFor(
        (f) => f.event === "org.event" && f.data?.result?.event?.id === eventId,
        `the org.event frame for ${eventId}`,
      );
      expect(frame.data.jsonrpc).toBe("2.0");
      expect(frame.data.id).toBe(rpcId);
      expect(frame.data.result.type).toBe("event");
      const ev = frame.data.result.event;
      expect(ev.authorId).toBe(P.id);
      expect(ev.kind).toBe("a2a-stream-test");
      expect(ev.summary).toBe(`note ${marker}`);
      expect(ev.targetIds).toEqual([A.id]);
      expect(typeof ev.position).toBe("string");

      // The delivery came from in-process catch-up reads made as the caller.
      const reads = readsFor(A.id);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((r) => !r.http)).toBe(true);
    } finally {
      await stream.close();
    }
  }, 40_000);

  it("an event targeted at another agent never reaches the stream, and every catch-up read behind it runs as the caller", async () => {
    // The COMPLETE read log, every participant: a read of any other agent's
    // catch-up made while this stream is open counts against it.
    const logBefore = probeReads().length;
    const { stream } = await postA2A(A, "message/stream", { agentId: A.id });
    const markerB = `marker-for-b-${randomUUID()}`;
    try {
      expect(stream.status).toBe(200);
      await publishEvent(P, { id: `a2688-for-b-${randomUUID()}`, targetIds: [B.id], summary: `note ${markerB}` });
      // A later event for A: once it arrives, the stream has read past B's event.
      const sentinelId = `a2688-sentinel-${randomUUID()}`;
      await publishEvent(P, { id: sentinelId, targetIds: [A.id], summary: "sentinel for a" });
      await stream.waitFor((f) => f.event === "org.event" && f.data?.result?.event?.id === sentinelId, "the sentinel for A");
      await sleep(POLL_MS + 500);
    } finally {
      await stream.close();
    }

    const received = stream.raw();
    expect(received.length).toBeGreaterThan(0);
    expect(carriesMarker(received, markerB)).toBe(false);
    // The scan finds the marker when it is present (raw, and base64-encoded).
    expect(carriesMarker(`x ${markerB} y`, markerB)).toBe(true);
    expect(carriesMarker(`data: {"b":"${Buffer.from(`{"s":"${markerB}"}`).toString("base64")}"}`, markerB)).toBe(true);

    const reads = probeReads().slice(logBefore);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect({ participantId: r.participantId, tpsAgent: r.tpsAgent, tpsAgentIsAdmin: r.tpsAgentIsAdmin, http: r.http })
        .toEqual({ participantId: A.id, tpsAgent: A.id, tpsAgentIsAdmin: false, http: false });
    }
  }, 40_000);

  it("a request naming another agent is refused with message/send's refusal and receives no event bytes", async () => {
    const markerB = `marker-refused-${randomUUID()}`;
    await publishEvent(P, { id: `a2688-refused-${randomUUID()}`, targetIds: [B.id], summary: `note ${markerB}` });
    const readsBefore = readsFor(B.id).length;

    const { rpcId, stream } = await postA2A(A, "message/stream", { agentId: B.id });
    const body = await settle(stream);
    expect(stream.contentType).not.toContain("text/event-stream");
    expect(SSE_EVENT_LINE.test(body)).toBe(false);
    expect(carriesMarker(body, markerB)).toBe(false);
    const answer = JSON.parse(body);
    expect(answer).toEqual({
      jsonrpc: "2.0",
      id: rpcId,
      error: { code: -32001, message: "Forbidden", data: { detail: `caller ${A.id} cannot stream as ${B.id}` } },
    });

    // message/send refuses the same caller naming the same agent with the same code and shape.
    const send = await postA2A(A, "message/send", { agentId: B.id, message: { parts: [{ text: "hi" }] } });
    const sendAnswer = JSON.parse(await settle(send.stream));
    expect(sendAnswer.error.code).toBe(answer.error.code);
    expect(sendAnswer.error.message).toBe(answer.error.message);
    expect(Object.keys(sendAnswer.error.data)).toEqual(Object.keys(answer.error.data));
    expect(sendAnswer.error.data.detail).toBe(`caller ${A.id} cannot send as ${B.id}`);

    // No catch-up read for B ran.
    await sleep(POLL_MS + 500);
    expect(readsFor(B.id).length).toBe(readsBefore);
  }, 40_000);

  it("an unauthenticated request keeps the existing refusal and receives no event bytes", async () => {
    const marker = `marker-anon-${randomUUID()}`;
    await publishEvent(P, { id: `a2688-anon-${randomUUID()}`, targetIds: [D.id], summary: `note ${marker}` });
    const readsBefore = readsFor(D.id).length;

    const { rpcId, stream } = await postA2A(null, "message/stream", { agentId: D.id });
    const body = await settle(stream);
    expect(stream.contentType).not.toContain("text/event-stream");
    expect(SSE_EVENT_LINE.test(body)).toBe(false);
    expect(carriesMarker(body, marker)).toBe(false);
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: rpcId,
      error: { code: -32001, message: "Unauthorized", data: { detail: "POST /a2a requires TPS-Ed25519 or admin Basic auth" } },
    });

    await sleep(POLL_MS + 500);
    expect(readsFor(D.id).length).toBe(readsBefore);
  }, 30_000);

  it("a request without agentId keeps its -32602 refusal", async () => {
    const { rpcId, stream } = await postA2A(A, "message/stream", {});
    const body = await settle(stream);
    expect(SSE_EVENT_LINE.test(body)).toBe(false);
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: "Invalid params: agentId is required" },
    });
  }, 20_000);

  it("after the client disconnects no further catch-up read runs and Harper logs no error", async () => {
    const { stream } = await postA2A(E, "message/stream", { agentId: E.id });
    expect(stream.status).toBe(200);
    // Known-present: the stream polls while the client is connected.
    await waitForReads(E.id, 2);

    const logAtClose = (harper.getLog?.() ?? "").length;
    await stream.close();
    await sleep(1_500); // Harper sees the disconnect; an in-flight read finishes.
    const atClose = readsFor(E.id).length;

    // Known-absent: three poll intervals later, nothing more has read E's catch-up.
    await sleep(POLL_MS * 3 + 1_000);
    expect(readsFor(E.id).length).toBe(atClose);

    const logAfter = (harper.getLog?.() ?? "").slice(logAtClose);
    expect(logAfter).not.toMatch(/\[error\]|ERR_INVALID_STATE|Invalid state|uncaught|unhandled/i);
  }, 40_000);
});
