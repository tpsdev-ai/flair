import { describe, expect, test } from "bun:test";
import { FlairError } from "@tpsdev-ai/flair-client";
import {
  buildLaunchReceipt,
  cursorLaunchHostSource,
  isAcceptableHostSourceUrl,
  launchReceiptId,
  permanentReceiptRefusal,
  runWakeCycle,
  wakeAgentId,
  type CatchupPage,
  type CatchupPort,
  type CursorAgentClient,
  type LaunchInput,
  type LaunchResult,
  type ReceiptStore,
} from "../src/index.ts";

// Neutral fixture names only (no real fleet hosts or agents).
const CREW = "agent-a";

function dispatchEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-1",
    kind: "coord.dispatch",
    summary: "a light brief",
    detail: "https://github.com/example-org/example-repo/issues/7",
    targetIds: [CREW],
    authorId: "agent-b",
    position: "p1",
    ...overrides,
  };
}

interface Stored {
  content: string;
  hostSource?: { host: string; kind: string; id: string; url?: string };
}

/** A receipt store that records every call into the shared `order` log. */
function fakeStore(
  order: string[],
  opts: {
    failWrite?: boolean;
    failRead?: boolean;
    /** Thrown by write() for the receipt ids it names (all ids when `writeErrorFor` is omitted). */
    writeError?: unknown;
    writeErrorFor?: string[];
    readError?: unknown;
  } = {},
): { store: ReceiptStore; records: Map<string, Stored> } {
  const records = new Map<string, Stored>();
  const store: ReceiptStore = {
    has: async (id) => {
      order.push(`has:${id}`);
      if (opts.readError !== undefined) throw opts.readError;
      if (opts.failRead) throw new Error("store read unavailable");
      return records.has(id);
    },
    write: async (receipt) => {
      order.push(`write:${receipt.id}`);
      if (opts.writeError !== undefined && (!opts.writeErrorFor || opts.writeErrorFor.includes(receipt.id))) {
        throw opts.writeError;
      }
      if (opts.failWrite) throw new Error("server refused the receipt");
      records.set(receipt.id, { content: receipt.content, hostSource: receipt.hostSource });
    },
  };
  return { store, records };
}

function catchupWith(order: string[], pages: CatchupPage[]): { port: CatchupPort; acks: string[] } {
  const acks: string[] = [];
  let i = 0;
  return {
    acks,
    port: {
      drain: async () => pages[Math.min(i++, pages.length - 1)] ?? { events: [], hasMore: false },
      ack: async (position) => {
        order.push(`ack:${position}`);
        acks.push(position);
      },
    },
  };
}

function cursorReturning(result: LaunchResult): { client: CursorAgentClient; calls: LaunchInput[] } {
  const calls: LaunchInput[] = [];
  return { calls, client: { create: async (input) => (calls.push(input), result) } };
}

describe("launchReceiptId — a stable id distinct from the Cursor agent id", () => {
  test("deterministic per OrgEvent id, and never the bc- agent id", () => {
    expect(launchReceiptId("evt-1")).toBe(launchReceiptId("evt-1"));
    expect(launchReceiptId("evt-1")).not.toBe(launchReceiptId("evt-2"));
    expect(launchReceiptId("evt-1")).not.toBe(wakeAgentId("evt-1"));
    expect(launchReceiptId("evt-1").startsWith("bc-")).toBe(false);
    expect(() => launchReceiptId("")).toThrow("non-empty");
  });
});

describe("buildLaunchReceipt — content + host source, omitting what the grammar refuses", () => {
  test("names only the dispatch id and the Cursor agent id; url carried verbatim", () => {
    const built = buildLaunchReceipt("evt-1", { cursorAgentId: "bc-1", url: "https://cursor.example/agents/bc-1" });
    expect(built.receipt.id).toBe(launchReceiptId("evt-1"));
    expect(built.receipt.content).toContain("evt-1");
    expect(built.receipt.content).toContain("bc-1");
    expect(built.receipt.hostSource).toEqual({
      host: "cursor",
      kind: "launch",
      id: "bc-1",
      url: "https://cursor.example/agents/bc-1",
    });
    expect(built.omittedUrl).toBe(false);
    expect(built.omittedSource).toBe(false);
  });

  test("the content never echoes the dispatch text or the prompt", () => {
    const built = buildLaunchReceipt("evt-1", { cursorAgentId: "bc-1" });
    expect(built.receipt.content).not.toContain("a light brief");
    expect(built.receipt.content).not.toContain("example-repo");
    expect(built.receipt.hostSource).toEqual({ host: "cursor", kind: "launch", id: "bc-1" });
  });

  test("a url the grammar refuses is omitted, the source still lands", () => {
    for (const url of ["http://cursor.example/x", "https://@cursor.example/x", `https://cursor.example/${"a".repeat(2100)}`]) {
      const built = buildLaunchReceipt("evt-1", { cursorAgentId: "bc-1", url });
      expect(built.receipt.hostSource).toEqual({ host: "cursor", kind: "launch", id: "bc-1" });
      expect(built.omittedUrl).toBe(true);
      expect(built.omittedSource).toBe(false);
    }
  });

  test("an id the grammar refuses omits the whole source", () => {
    const built = buildLaunchReceipt("evt-1", { cursorAgentId: "not a valid id", url: "https://cursor.example/x" });
    expect(built.receipt.hostSource).toBeUndefined();
    expect(built.omittedSource).toBe(true);
  });

  test("isAcceptableHostSourceUrl mirrors the server: https, no userinfo, capped", () => {
    expect(isAcceptableHostSourceUrl("https://cursor.example/x")).toBe(true);
    expect(isAcceptableHostSourceUrl("http://cursor.example/x")).toBe(false);
    expect(isAcceptableHostSourceUrl("https://@cursor.example/x")).toBe(false);
    expect(cursorLaunchHostSource("bc-1").hostSource).toEqual({ host: "cursor", kind: "launch", id: "bc-1" });
  });
});

describe("runWakeCycle — the launch receipt (flair#1944)", () => {
  test("a created launch writes the receipt BEFORE the ack; it reads back with the stable id", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({
      outcome: "created",
      cursorAgentId: "bc-1",
      url: "https://cursor.example/agents/bc-1",
    });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store });
    expect(result.receiptFailed).toBeNull();
    expect(result.acked).toBe("p1");
    const id = launchReceiptId("evt-1");
    expect(records.get(id)?.hostSource).toEqual({
      host: "cursor",
      kind: "launch",
      id: "bc-1",
      url: "https://cursor.example/agents/bc-1",
    });
    expect(order.indexOf(`write:${id}`)).toBeLessThan(order.indexOf("ack:p1"));
    expect(acks).toEqual(["p1"]);
  });

  test("a replay that reuses the agent writes no second receipt and leaves the url-bearing one unchanged", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const first = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const second = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const created = cursorReturning({
      outcome: "created",
      cursorAgentId: "bc-1",
      url: "https://cursor.example/agents/bc-1",
    });
    const already = cursorReturning({ outcome: "already", cursorAgentId: "bc-1" });
    await runWakeCycle({ agentId: CREW, catchup: first.port, cursor: created.client, receipts: store });
    const replay = await runWakeCycle({ agentId: CREW, catchup: second.port, cursor: already.client, receipts: store });
    expect(records.size).toBe(1);
    expect(records.get(launchReceiptId("evt-1"))?.hostSource?.url).toBe("https://cursor.example/agents/bc-1");
    expect(replay.items[0].receipt).toBe("unchanged");
    expect(second.acks).toEqual(["p1"]);
  });

  test("a receipt write failure is a named outcome and does not ack", async () => {
    const order: string[] = [];
    const { store } = fakeStore(order, { failWrite: true });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store });
    expect(result.receiptFailed).toContain("evt-1");
    expect(result.items[0].receipt).toBe("failed");
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    expect(order.some((entry) => entry.startsWith("ack:"))).toBe(false);
  });

  test("an unreadable store (failed has) does not license a write and does not ack", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order, { failRead: true });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store });
    expect(result.receiptFailed).toContain("evt-1");
    expect(records.size).toBe(0);
    expect(acks).toEqual([]);
  });

  test("a launch failure is still a launch failure, not a receipt failure", async () => {
    const order: string[] = [];
    const { store } = fakeStore(order);
    const { port } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const client: CursorAgentClient = {
      create: async () => {
        throw new Error("cursor down");
      },
    };
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store });
    expect(result.blocked).toContain("evt-1");
    expect(result.receiptFailed).toBeNull();
  });

  test("dry-run writes no receipt and acks nothing", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client, calls } = cursorReturning({ outcome: "dry-run", cursorAgentId: "bc-1" });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store, dryRun: true });
    expect(result.items[0].action).toBe("dry-run");
    expect(result.items[0].receipt).toBeUndefined();
    expect(records.size).toBe(0);
    expect(acks).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/** The error flair-client throws for a non-2xx response: status + (at most 500 chars of) body. */
function serverError(status: number, body: string): FlairError {
  return new FlairError("PUT", "/Memory/x", status, body.slice(0, 500));
}

/** A refusal body that echoes a submitted value — the echo must never reach the result or the log. */
const ECHOING_400 = JSON.stringify({
  error: "invalid_host_source",
  message: 'hostSource.id "ECHOED-SUBMITTED-VALUE" does not match the id grammar',
});

describe("permanentReceiptRefusal — which receipt write failures are permanent (flair#1944)", () => {
  test("400, 409, 413 and 422 are permanent, with the status and the named error code", () => {
    for (const status of [400, 409, 413, 422]) {
      expect(permanentReceiptRefusal(serverError(status, ECHOING_400))).toEqual({ status, code: "invalid_host_source" });
    }
  });

  test("a network error, a timeout, 401, 403, 404, 408, 429 and any 5xx are not", () => {
    expect(permanentReceiptRefusal(new TypeError("fetch failed"))).toBeNull();
    expect(permanentReceiptRefusal(new DOMException("The operation timed out.", "TimeoutError"))).toBeNull();
    expect(permanentReceiptRefusal(new Error("server refused the receipt"))).toBeNull();
    expect(permanentReceiptRefusal(undefined)).toBeNull();
    for (const status of [401, 403, 404, 408, 429, 500, 502, 503, 504]) {
      expect(permanentReceiptRefusal(serverError(status, ECHOING_400)), `HTTP ${status}`).toBeNull();
    }
  });

  test("the code is only a named token: free text, non-JSON and a missing error read as null", () => {
    expect(permanentReceiptRefusal(serverError(400, JSON.stringify({ error: "supersedes must be a string (memory ID)" })))?.code).toBeNull();
    expect(permanentReceiptRefusal(serverError(400, "Bad Request"))?.code).toBeNull();
    expect(permanentReceiptRefusal(serverError(400, ""))?.code).toBeNull();
    expect(permanentReceiptRefusal(serverError(400, JSON.stringify({ message: "no code" })))?.code).toBeNull();
  });

  test("a body FlairError truncated at 500 characters still yields its leading code", () => {
    const long = JSON.stringify({ error: "content_safety_violation", message: "x".repeat(800) });
    const err = serverError(400, long);
    expect(err.body.length).toBe(500);
    expect(permanentReceiptRefusal(err)).toEqual({ status: 400, code: "content_safety_violation" });
  });
});

describe("runWakeCycle — a receipt the server permanently refuses (flair#1944)", () => {
  test("a 400 is acked, reported as receiptRefused with status + code only, and logged once", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order, { writeError: serverError(400, ECHOING_400) });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const lines: string[] = [];
    const result = await runWakeCycle({
      agentId: CREW,
      catchup: port,
      cursor: client,
      receipts: store,
      log: (line) => lines.push(line),
    });
    expect(result.receiptFailed).toBeNull();
    expect(result.receiptRefused).toEqual([{ eventId: "evt-1", status: 400, code: "invalid_host_source" }]);
    expect(result.items[0].receipt).toBe("refused");
    expect(result.acked).toBe("p1");
    expect(acks).toEqual(["p1"]);
    expect(records.size).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("evt-1");
    expect(lines[0]).toContain("400 invalid_host_source");
    expect(JSON.stringify(result)).not.toContain("ECHOED-SUBMITTED-VALUE");
    expect(lines[0]).not.toContain("ECHOED-SUBMITTED-VALUE");
  });

  test("a refusal does not hold the feed: the next dispatch in the cycle still launches and records its receipt", async () => {
    const order: string[] = [];
    const first = dispatchEvent({ id: "evt-1", position: "p1" });
    const second = dispatchEvent({ id: "evt-2", position: "p2" });
    const { store, records } = fakeStore(order, {
      writeError: serverError(422, JSON.stringify({ error: "reembed_no_text" })),
      writeErrorFor: [launchReceiptId("evt-1")],
    });
    const { port, acks } = catchupWith(order, [{ events: [first, second], hasMore: false }]);
    const { client, calls } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store });
    expect(calls.map((c) => c.dispatch.id)).toEqual(["evt-1", "evt-2"]);
    expect(result.items.map((i) => i.receipt)).toEqual(["refused", "written"]);
    expect(result.receiptRefused).toEqual([{ eventId: "evt-1", status: 422, code: "reembed_no_text" }]);
    expect(records.has(launchReceiptId("evt-2"))).toBe(true);
    expect(result.acked).toBe("p2");
    expect(acks).toEqual(["p2"]);
  });

  test("a transient or configuration failure (401, 403, 408, 429, 5xx, network) is still receiptFailed and not acked", async () => {
    const errors: unknown[] = [
      serverError(401, JSON.stringify({ error: "unauthorized" })),
      serverError(403, JSON.stringify({ error: "forbidden" })),
      serverError(408, ""),
      serverError(429, ""),
      serverError(500, ""),
      serverError(503, ""),
      new TypeError("fetch failed"),
    ];
    for (const writeError of errors) {
      const order: string[] = [];
      const { store } = fakeStore(order, { writeError });
      const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
      const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
      const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store });
      expect(result.receiptFailed, String(writeError)).toContain("evt-1");
      expect(result.receiptRefused).toEqual([]);
      expect(result.items[0].receipt).toBe("failed");
      expect(acks).toEqual([]);
    }
  });

  test("a failed READ is never a refusal, whatever its status: no write, no ack", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order, { readError: serverError(400, ECHOING_400) });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, receipts: store });
    expect(result.receiptFailed).toContain("evt-1");
    expect(result.receiptRefused).toEqual([]);
    expect(order.some((entry) => entry.startsWith("write:"))).toBe(false);
    expect(records.size).toBe(0);
    expect(acks).toEqual([]);
  });
});
