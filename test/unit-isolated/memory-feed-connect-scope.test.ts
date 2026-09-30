/**
 * FeedMemories.connect(): the loop that decides what a non-admin subscriber
 * receives, checked without Harper's `rowFilter`. Isolated: owns the harper
 * mock for MemoryFeed.ts.
 *
 * The mocked table subscription IGNORES the `rowFilter` it is given and yields
 * the crafted events exactly as listed, as a host Harper that does not honour
 * `rowFilter` would. The assertions below are therefore about connect()
 * alone: which events its loop delivers (a `put`/`invalidate` whose value is
 * an object), when it decides from the event's own `agentId` and
 * `visibility`, when it re-reads the stored row by id instead, and which of
 * the caller's options reach the table subscription request. The real-Harper
 * behaviour of both layers together is covered by
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

/**
 * Subscribe as READER and return the ids of every delivered event. In Harper's
 * instance mode the caller's subscription request is connect()'s second
 * argument, so `callerRequest` is passed there.
 */
async function delivered(callerRequest: any = {}): Promise<string[]> {
  const feed: any = new (FeedMemories as any)();
  feed.getContext = () => undefined;
  const out: string[] = [];
  for await (const event of feed.connect(null, callerRequest)) out.push(event.id);
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

  test("a partial put whose stored row is gone, or has no string agentId, is not delivered", async () => {
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

describe("FeedMemories.connect: the caller's subscription options", () => {
  const callerFilter = () => true;

  test("only the allowlisted options are copied, and the server's rowFilter is set last", async () => {
    await delivered({
      id: "w-shared",
      isCollection: false,
      onlyChildren: false,
      startTime: 1_790_000_000_000,
      previousCount: 3,
      omitCurrent: true,
      rowFilter: callerFilter,
      eventFilter: callerFilter,
      filter: callerFilter,
      select: ["id"],
      rawEvents: true,
      listener: callerFilter,
      supportsTransactions: true,
      conditions: [{ attribute: "agentId", value: WRITER }],
      checkPermission: false,
      unknownOption: "dropped",
    });
    expect(Object.keys(lastRequest).sort()).toEqual(
      ["id", "isCollection", "onlyChildren", "omitCurrent", "previousCount", "rowFilter", "startTime"].sort(),
    );
    expect(lastRequest.id).toBe("w-shared");
    expect(lastRequest.startTime).toBe(1_790_000_000_000);
    expect(lastRequest.previousCount).toBe(3);
    expect(lastRequest.omitCurrent).toBe(true);
    expect(lastRequest.rowFilter).not.toBe(callerFilter);
    expect(lastRequest.rowFilter(stored.get("w-private"))).toBe(false);
  });

  test("an option with an unexpected type is dropped", async () => {
    await delivered({ id: { attribute: "agentId" }, startTime: "0", previousCount: Number.NaN, omitCurrent: "yes", isCollection: 1 });
    expect(Object.keys(lastRequest)).toEqual(["rowFilter"]);
  });

  test("a caller rowFilter or filter that admits everything is ignored", async () => {
    events = [put("w-private", stored.get("w-private")), put("w-shared", stored.get("w-shared"))];
    expect(await delivered({ rowFilter: callerFilter, filter: callerFilter, eventFilter: callerFilter })).toEqual(["w-shared"]);
    expect(lastRequest.rowFilter).not.toBe(callerFilter);
  });

  test("a history replay delivers an earlier version only while the record's stored row is readable", async () => {
    // Earlier versions carry their own agentId/visibility (shared at the time).
    const earlierShared = (id: string) => put(id, { id, agentId: WRITER, visibility: "shared", content: "earlier version" });
    stored.set("now-private", { id: "now-private", agentId: WRITER, visibility: "private", content: "private now" });
    stored.set("still-shared", { id: "still-shared", agentId: WRITER, visibility: "shared", content: "shared now" });
    failingReads.add("read-fails");
    events = [earlierShared("now-private"), earlierShared("deleted"), earlierShared("read-fails"), earlierShared("still-shared")];
    expect(await delivered({ startTime: 1 })).toEqual(["still-shared"]);
    expect(reads).toEqual(["now-private", "deleted", "read-fails", "still-shared"]);
    reads = [];
    expect(await delivered({ previousCount: 5 })).toEqual(["still-shared"]);
    expect(reads).toEqual(["now-private", "deleted", "read-fails", "still-shared"]);
  });
});
