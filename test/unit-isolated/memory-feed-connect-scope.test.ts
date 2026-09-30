/**
 * FeedMemories.connect(): the loop that decides what a non-admin subscriber
 * receives does not depend on Harper's `rowFilter` or on the shape of the
 * event. Isolated: owns the harper mock for MemoryFeed.ts.
 *
 * The mocked table subscription IGNORES the `rowFilter` it is given and yields
 * the crafted events exactly as listed, as a host Harper that does not honour
 * `rowFilter` would. Every assertion below is therefore about the second layer
 * alone. The real-Harper behaviour of both layers together is covered by
 * test/integration/feed-read-scope.test.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

const READER = "reader";
const WRITER = "writer";

let stored: Map<string, any>;
let failingReads: Set<string>;
let reads: string[];
let events: any[];
let lastRequest: any;

const databasesMock = {
  flair: {
    Memory: {
      get: async (id: string) => {
        reads.push(id);
        if (failingReads.has(id)) throw new Error("storage unavailable");
        return stored.get(id);
      },
      subscribe: async (request: any) => {
        lastRequest = request;
        const queued = events.slice();
        return (async function* () {
          for (const event of queued) yield event;
        })();
      },
    },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
}));

mock.module("../../resources/agent-auth.ts", () => ({
  allowVerified: async () => true,
  resolveAgentAuth: async () => ({ kind: "agent", agentId: READER, isAdmin: false }),
}));

const { FeedMemories } = await import("../../resources/MemoryFeed.ts");

/** Subscribe as READER and return the ids of every delivered event. */
async function delivered(): Promise<string[]> {
  const feed: any = new (FeedMemories as any)();
  feed.getContext = () => undefined;
  const out: string[] = [];
  for await (const event of feed.connect(null, {})) out.push(event.id);
  return out;
}

const put = (id: string, value: any) => ({ type: "put", id, value });

beforeEach(() => {
  stored = new Map([
    ["w-private", { id: "w-private", agentId: WRITER, visibility: "private", content: "writer private" }],
    ["w-shared", { id: "w-shared", agentId: WRITER, visibility: "shared", content: "writer shared" }],
    ["r-private", { id: "r-private", agentId: READER, visibility: "private", content: "reader private" }],
    ["w-unset", { id: "w-unset", agentId: WRITER, content: "writer, stored without visibility" }],
  ]);
  failingReads = new Set();
  reads = [];
  events = [];
  lastRequest = undefined;
});

describe("FeedMemories.connect: partial events are decided from the stored row", () => {
  test("a partial put for another agent's private record, without visibility, is not delivered", async () => {
    events = [
      put("w-private", { id: "w-private", content: "writer private" }),
      put("w-private", { id: "w-private", agentId: WRITER, content: "writer private" }),
    ];
    expect(await delivered()).toEqual([]);
    expect(reads).toEqual(["w-private", "w-private"]);
  });

  test("a partial put for a record the reader may see is delivered after the stored row is read", async () => {
    events = [
      put("w-shared", { id: "w-shared", content: "writer shared" }),
      put("r-private", { id: "r-private", agentId: READER }),
    ];
    expect(await delivered()).toEqual(["w-shared", "r-private"]);
    expect(reads).toEqual(["w-shared", "r-private"]);
  });

  test("a partial put whose stored-row read fails is not delivered", async () => {
    failingReads.add("w-shared");
    events = [put("w-shared", { id: "w-shared", content: "writer shared" })];
    expect(await delivered()).toEqual([]);
    expect(reads).toEqual(["w-shared"]);
  });

  test("a partial put whose stored row is gone, or is not a Memory row, is not delivered", async () => {
    stored.set("not-a-row", { id: "not-a-row", content: "no owner" });
    events = [
      put("gone", { id: "gone", content: "deleted meanwhile" }),
      put("not-a-row", { id: "not-a-row", content: "no owner" }),
    ];
    expect(await delivered()).toEqual([]);
    expect(reads).toEqual(["gone", "not-a-row"]);
  });
});

describe("FeedMemories.connect: full rows and other events", () => {
  test("a row carrying agentId and visibility is decided from the row, without a re-read", async () => {
    events = [
      put("w-private", stored.get("w-private")),
      put("w-shared", stored.get("w-shared")),
      put("r-private", stored.get("r-private")),
    ];
    expect(await delivered()).toEqual(["w-shared", "r-private"]);
    expect(reads).toEqual([]);
  });

  test("a row stored without a visibility field reads as org-open", async () => {
    events = [put("w-unset", stored.get("w-unset"))];
    expect(await delivered()).toEqual(["w-unset"]);
    expect(reads).toEqual(["w-unset"]);
  });

  test("delete, message and row-less events are not delivered", async () => {
    events = [
      { type: "delete", id: "r-private" },
      { type: "message", id: "r-private", value: { id: "r-private", agentId: READER, visibility: "private" } },
      put("r-private", null),
      { type: "put", value: { content: "no id" } },
    ];
    expect(await delivered()).toEqual([]);
  });

  test("the scoped subscription request carries only the read-scope rowFilter", async () => {
    await delivered();
    expect(Object.keys(lastRequest)).toEqual(["rowFilter"]);
    expect(typeof lastRequest.rowFilter).toBe("function");
    expect(lastRequest.rowFilter(stored.get("w-private"))).toBe(false);
    expect(lastRequest.rowFilter(stored.get("w-shared"))).toBe(true);
    expect(lastRequest.rowFilter(stored.get("r-private"))).toBe(true);
  });
});
