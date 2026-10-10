import { describe, expect, test } from "bun:test";
import {
  buildLaunchReceipt,
  cursorLaunchHostSource,
  isAcceptableHostSourceUrl,
  launchReceiptId,
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
  opts: { failWrite?: boolean; failRead?: boolean } = {},
): { store: ReceiptStore; records: Map<string, Stored> } {
  const records = new Map<string, Stored>();
  const store: ReceiptStore = {
    has: async (id) => {
      order.push(`has:${id}`);
      if (opts.failRead) throw new Error("store read unavailable");
      return records.has(id);
    },
    write: async (receipt) => {
      order.push(`write:${receipt.id}`);
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
