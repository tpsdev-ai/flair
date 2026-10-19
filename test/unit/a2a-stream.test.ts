/**
 * a2a-stream.test.ts — the A2A `message/stream` body (resources/a2a-stream.ts).
 *
 * Harper-free: the stream reads through a supplied `readPage`, so these cases
 * pin its lifecycle directly. test/integration/a2a-message-stream-2688.test.ts
 * runs it against a real Harper with the in-process OrgEventCatchup reader.
 */
import { describe, expect, test } from "bun:test";
import { orgEventStream, type CatchupPage, type CatchupPageReader } from "../../resources/a2a-stream";

const POLL_MS = 15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame { event: string | null; data: any; comment: string | null }

function parseFrames(raw: string): Frame[] {
  return raw
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? null;
      const dataLine = lines.find((l) => l.startsWith("data: "));
      const comment = lines.find((l) => l.startsWith(":")) ?? null;
      return { event, data: dataLine ? JSON.parse(dataLine.slice(6)) : null, comment };
    });
}

/** Read the stream until it ends or `ms` passes; returns everything received. */
async function collect(stream: ReadableStream<Uint8Array>, ms: number): Promise<{ raw: string; done: boolean }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let raw = "";
  let done = false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      sleep(Math.max(1, deadline - Date.now())).then(() => null),
    ]);
    if (next === null) break;
    if (next.done) { done = true; break; }
    raw += dec.decode(next.value, { stream: true });
  }
  if (!done) await reader.cancel().catch(() => {});
  else reader.releaseLock();
  return { raw, done };
}

function page(events: any[], nextAfter: string, hasMore = false): CatchupPage {
  return { events, nextAfter, hasMore };
}

function event(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "note", summary: `summary ${id}`, createdAt: "2026-10-19T00:00:00.000Z", targetIds: ["a"], position: `p-${id}`, ...extra };
}

describe("orgEventStream", () => {
  test("opens with a comment and delivers each read event as an org.event frame carrying the event", async () => {
    const calls: string[] = [];
    const readPage: CatchupPageReader = async (after) => {
      calls.push(after);
      if (calls.length === 1) return page([event("e1"), event("e2")], "p-e2");
      return page([], after);
    };
    const { raw } = await collect(orgEventStream({ rpcId: 7, readPage, startAfter: "start", pollMs: POLL_MS }), POLL_MS * 6);
    const frames = parseFrames(raw);
    expect(frames[0].comment).toBe(": stream open");
    const delivered = frames.filter((f) => f.event === "org.event");
    expect(delivered.map((f) => f.data.result.event.id)).toEqual(["e1", "e2"]);
    expect(delivered[0].data).toEqual({ jsonrpc: "2.0", id: 7, result: { type: "event", event: event("e1") } });
    // The first read starts at the opening cursor; later reads continue from the page's nextAfter.
    expect(calls[0]).toBe("start");
    expect(calls.slice(1).every((c) => c === "p-e2")).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });

  test("drains every page a poll reports with hasMore before waiting for the next poll", async () => {
    const calls: string[] = [];
    const readPage: CatchupPageReader = async (after) => {
      calls.push(after);
      if (after === "start") return page([event("e1")], "p-e1", true);
      if (after === "p-e1") return page([event("e2")], "p-e2", false);
      return page([], after);
    };
    const { raw } = await collect(orgEventStream({ rpcId: 1, readPage, startAfter: "start", pollMs: 10_000 }), 100);
    expect(parseFrames(raw).filter((f) => f.event === "org.event").map((f) => f.data.result.event.id)).toEqual(["e1", "e2"]);
    expect(calls).toEqual(["start", "p-e1"]);
  });

  test("an event with a task status adds a task.status frame after its org.event frame", async () => {
    let n = 0;
    const readPage: CatchupPageReader = async (after) =>
      n++ === 0 ? page([event("s1", { refId: "bd://ops-1", detail: JSON.stringify({ status: "working" }) })], "p-s1") : page([], after);
    const { raw } = await collect(orgEventStream({ rpcId: "r", readPage, startAfter: "start", pollMs: POLL_MS }), POLL_MS * 4);
    const frames = parseFrames(raw).filter((f) => f.event);
    expect(frames.map((f) => f.event)).toEqual(["org.event", "task.status"]);
    expect(frames[1].data.result).toEqual({ type: "task", task: { id: "ops-1", status: "working" } });
  });

  test("a terminal status for the task the request named ends the stream", async () => {
    const calls: string[] = [];
    const readPage: CatchupPageReader = async (after) => {
      calls.push(after);
      return page([event("t1", { refId: "bd://ops-9", detail: JSON.stringify({ status: "completed" }) }), event("t2")], "p-t2");
    };
    const { raw, done } = await collect(
      orgEventStream({ rpcId: 1, readPage, startAfter: "start", taskId: "ops-9", pollMs: POLL_MS }),
      POLL_MS * 8,
    );
    expect(done).toBe(true);
    expect(calls).toEqual(["start"]);
    // t2 follows the terminal event in the same page and is not delivered.
    expect(parseFrames(raw).filter((f) => f.event === "org.event").map((f) => f.data.result.event.id)).toEqual(["t1"]);
  });

  test("a terminal-looking event for another task, or with no task named, does not end the stream", async () => {
    for (const taskId of [null, "ops-other"]) {
      let n = 0;
      const readPage: CatchupPageReader = async (after) =>
        n++ === 0 ? page([event("d1", { summary: "the deploy is done", refId: "bd://ops-9" })], "p-d1") : page([], after);
      const { done } = await collect(orgEventStream({ rpcId: 1, readPage, startAfter: "start", taskId, pollMs: POLL_MS }), POLL_MS * 6);
      expect(done).toBe(false);
      expect(n).toBeGreaterThan(1);
    }
  });

  test("a refusal from the catch-up ends the stream with a JSON-RPC error frame and no further read", async () => {
    let calls = 0;
    const readPage: CatchupPageReader = async () => {
      calls++;
      return new Response(JSON.stringify({ error: "forbidden: can only fetch events for yourself" }), { status: 403 });
    };
    const { raw, done } = await collect(orgEventStream({ rpcId: 3, readPage, startAfter: "start", pollMs: POLL_MS }), POLL_MS * 8);
    expect(done).toBe(true);
    expect(calls).toBe(1);
    const errors = parseFrames(raw).filter((f) => f.event === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32001, message: "Forbidden", data: { detail: "forbidden: can only fetch events for yourself" } },
    });
    expect(parseFrames(raw).some((f) => f.event === "org.event")).toBe(false);
  });

  test("a failed read ends the stream with a JSON-RPC error frame and no further read", async () => {
    let calls = 0;
    const readPage: CatchupPageReader = async () => {
      calls++;
      throw new Error("catch-up store unavailable");
    };
    const { raw, done } = await collect(orgEventStream({ rpcId: 4, readPage, startAfter: "start", pollMs: POLL_MS }), POLL_MS * 8);
    expect(done).toBe(true);
    expect(calls).toBe(1);
    const errors = parseFrames(raw).filter((f) => f.event === "error");
    expect(errors.map((f) => f.data)).toEqual([
      { jsonrpc: "2.0", id: 4, error: { code: -32000, message: "Server error", data: { detail: "catch-up store unavailable" } } },
    ]);
  });

  test("a read that returns no page ends the stream with a JSON-RPC error frame", async () => {
    const readPage = (async () => undefined) as unknown as CatchupPageReader;
    const { raw, done } = await collect(orgEventStream({ rpcId: 5, readPage, startAfter: "start", pollMs: POLL_MS }), POLL_MS * 8);
    expect(done).toBe(true);
    expect(parseFrames(raw).filter((f) => f.event === "error").map((f) => f.data.error.code)).toEqual([-32000]);
  });

  test("cancelling the stream stops the polling: no read starts after the cancel", async () => {
    let calls = 0;
    const readPage: CatchupPageReader = async (after) => { calls++; return page([], after); };
    const stream = orgEventStream({ rpcId: 1, readPage, startAfter: "start", pollMs: POLL_MS });
    const reader = stream.getReader();
    await reader.read(); // the opening comment
    await sleep(POLL_MS * 5);
    expect(calls).toBeGreaterThan(1); // polling while open
    await reader.cancel();
    const atCancel = calls;
    await sleep(POLL_MS * 8);
    expect(calls).toBe(atCancel);
  });

  test("a read in flight when the stream is cancelled writes nothing and schedules no further read", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const readPage: CatchupPageReader = async (after) => {
      calls++;
      await gate;
      return page([event("late")], "p-late");
    };
    const stream = orgEventStream({ rpcId: 1, readPage, startAfter: "start", pollMs: POLL_MS });
    const reader = stream.getReader();
    await reader.read(); // the opening comment
    await sleep(POLL_MS);
    expect(calls).toBe(1);
    await reader.cancel();
    release();
    await sleep(POLL_MS * 6);
    expect(calls).toBe(1);
  });

  test("the stream ends after maxMs", async () => {
    let calls = 0;
    const readPage: CatchupPageReader = async (after) => { calls++; return page([], after); };
    const { done } = await collect(orgEventStream({ rpcId: 1, readPage, startAfter: "start", pollMs: POLL_MS, maxMs: POLL_MS * 4 }), POLL_MS * 20);
    expect(done).toBe(true);
    const atEnd = calls;
    await sleep(POLL_MS * 5);
    expect(calls).toBe(atEnd);
  });
});
