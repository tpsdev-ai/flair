import { describe, expect, test } from "bun:test";
import { FlairError } from "@tpsdev-ai/flair-client";
import type { FlairClient } from "@tpsdev-ai/flair-client";
import {
  buildLaunchReceipt,
  cursorLaunchHostSource,
  dryRunCursorClient,
  isAcceptableHostSourceUrl,
  isStoredReceipt,
  launchReceiptId,
  permanentReceiptRefusal,
  wakeAgentId,
  type CatchupPage,
  type CatchupPort,
  type CursorAgentClient,
  type CursorLaunchConfig,
  type LaunchInput,
  type LaunchResult,
  type ReceiptStore,
  type WakeDeps,
  type WakeResult,
} from "../src/index.ts";
// flair#1944 round 8 — the internal core that takes the test seams is NOT on the
// package's public entry (`src/index.ts`); tests reach it from its own module.
import { runWakeCycleCore } from "../src/run.ts";

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

/** A receipt store that records every call into the shared `order` log. Every
 *  row is authored by `opts.author` (default CREW) unless `opts.authors` names a
 *  different one for an id — so a case can seed a row owned by ANOTHER agent. */
function fakeStore(
  order: string[],
  opts: {
    failWrite?: boolean;
    failRead?: boolean;
    /** Thrown by write() for the receipt ids it names (all ids when `writeErrorFor` is omitted). */
    writeError?: unknown;
    writeErrorFor?: string[];
    readError?: unknown;
    /** The author of every row not named in `authors`. */
    author?: string;
    /** Per-id authors (a row owned by another agent). */
    authors?: Map<string, string>;
    /** Pre-seed rows already at an id. */
    seed?: Map<string, Stored>;
  } = {},
): { store: ReceiptStore; records: Map<string, Stored> } {
  const records = opts.seed ?? new Map<string, Stored>();
  const store: ReceiptStore = {
    agentId: CREW,
    read: async (id) => {
      order.push(`read:${id}`);
      if (opts.readError !== undefined) throw opts.readError;
      if (opts.failRead) throw new Error("store read unavailable");
      const row = records.get(id);
      if (row === undefined) return null;
      return {
        author: opts.authors?.get(id) ?? opts.author ?? CREW,
        content: row.content,
        ...(row.hostSource ? { hostSource: row.hostSource } : {}),
      };
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

const CURSOR_CONFIG: CursorLaunchConfig = { apiBase: "https://api.cursor.com", apiKey: "k" };

/**
 * Wrap a `ReceiptStore` into a fake `FlairClient` whose `memory` delegates to it,
 * so a cycle — which now BUILDS the receipt store from the client it runs —
 * drives exactly this store. `request` is never reached: the catchup feed is
 * supplied as a canned port to the internal core (`runWakeCycleCore`). The
 * client's `agentId` is the store's, so the runner identity and the signer are
 * the same by construction (flair#1944 round 7).
 */
function clientFromStore(store: ReceiptStore): FlairClient {
  return {
    agentId: store.agentId,
    request: async () => {
      throw new Error("unexpected request: this fake client is given a canned catchup feed");
    },
    memory: {
      get: async (id: string) => {
        const row = await store.read(id);
        if (row === null) return null;
        return {
          id,
          agentId: row.author,
          content: row.content,
          ...(row.hostSource === undefined ? {} : { hostSource: row.hostSource }),
        };
      },
      write: async (content: string, opts: { id?: string; hostSource?: unknown } = {}) => {
        await store.write({
          id: opts.id as string,
          content,
          ...(opts.hostSource ? { hostSource: opts.hostSource as never } : {}),
        });
        return { id: opts.id };
      },
    },
  } as unknown as FlairClient;
}

/**
 * Drive the INTERNAL core (test-only; `src/index.ts` does not export it) on a
 * fake store + canned feed (+ optional fake Cursor client). The exported
 * `runWakeCycle` builds production parts only — the seams live here.
 */
function runCycle(
  store: ReceiptStore,
  port: CatchupPort,
  cursor?: CursorAgentClient,
  extra: Partial<WakeDeps> = {},
): Promise<WakeResult> {
  const deps: WakeDeps = { client: clientFromStore(store), cursor: CURSOR_CONFIG, ...extra };
  return runWakeCycleCore(deps, { catchup: port, cursor: cursor ?? dryRunCursorClient() });
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
    const result = await runCycle(store, port, client);
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
    // Also the "this runner's own MATCHING receipt -> unchanged + ack" case: the
    // stored row VERIFIES (author, content, host-source identity) and its url is
    // not part of the identity.
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
    await runCycle(store, first.port, created.client);
    const replay = await runCycle(store, second.port, already.client);
    expect(records.size).toBe(1);
    expect(records.get(launchReceiptId("evt-1"))?.hostSource?.url).toBe("https://cursor.example/agents/bc-1");
    expect(replay.items[0].receipt).toBe("unchanged");
    expect(second.acks).toEqual(["p1"]);
  });

  test("an `already` result that carries a url does NOT write it (flair#1944 round 6)", async () => {
    // The url belongs to the ORIGINAL create; a 409 replay that reports a url
    // must not put one on the receipt. On a fresh id (no stored row) the write
    // lands, but with no url.
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({
      outcome: "already",
      cursorAgentId: "bc-1",
      url: "https://cursor.example/agents/bc-1",
    });
    const result = await runCycle(store, port, client);
    expect(result.items[0].receipt).toBe("written");
    const stored = records.get(launchReceiptId("evt-1"))?.hostSource;
    expect(stored, "the receipt carries the source but not the replay's url").toEqual({ host: "cursor", kind: "launch", id: "bc-1" });
    expect(stored?.url, "an `already` url is never written").toBeUndefined();
    expect(result.acked).toBe("p1");
    expect(acks).toEqual(["p1"]);
  });

  test("a receipt write failure is a named outcome and does not ack", async () => {
    const order: string[] = [];
    const { store } = fakeStore(order, { failWrite: true });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const result = await runCycle(store, port, client);
    expect(result.receiptFailed).toContain("evt-1");
    expect(result.items[0].receipt).toBe("failed");
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    expect(order.some((entry) => entry.startsWith("ack:"))).toBe(false);
  });

  test("an unreadable store (failed read) does not license a write and does not ack", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order, { failRead: true });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const result = await runCycle(store, port, client);
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
    const result = await runCycle(store, port, client);
    expect(result.blocked).toContain("evt-1");
    expect(result.receiptFailed).toBeNull();
  });

  test("dry-run writes no receipt and acks nothing", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    // No fake Cursor client: a dry-run cycle builds the dry-run client itself
    // and never touches the network.
    const result = await runCycle(store, port, undefined, { dryRun: true });
    expect(result.items[0].action).toBe("dry-run");
    expect(result.items[0].receipt).toBeUndefined();
    expect(records.size).toBe(0);
    expect(acks).toEqual([]);
  });
});

describe("isStoredReceipt — a row is this runner's receipt only if it VERIFIES (flair#1944 round 3)", () => {
  const receipt = buildLaunchReceipt("evt-1", { cursorAgentId: "bc-1", url: "https://cursor.example/agents/bc-1" }).receipt;

  test("matches on the same author, content and host-source identity; the url is not identity", () => {
    expect(
      isStoredReceipt({ author: CREW, content: receipt.content, hostSource: receipt.hostSource }, CREW, receipt),
    ).toBe(true);
    // A replay carries no url; the stored url stands, and identity still matches.
    expect(
      isStoredReceipt(
        { author: CREW, content: receipt.content, hostSource: { host: "cursor", kind: "launch", id: "bc-1" } },
        CREW,
        receipt,
      ),
    ).toBe(true);
  });

  test("a source id the server stored NFC-normalised still matches the raw id (flair#1944 round 5)", () => {
    // Cursor can return an id whose NFC form is what the server stores and what a
    // read-back row carries — e.g. a KELVIN-SIGN `K` (U+212A) normalises to ASCII
    // `K`. The runner builds the expected id from the raw value; comparing raw
    // would call a legitimate replay a mismatch.
    const rawId = "bc-\u212A1e2d3c";
    const normalizedId = rawId.normalize("NFC");
    expect(normalizedId, "the id actually changes under NFC").not.toBe(rawId);
    const rawReceipt = buildLaunchReceipt("evt-1", { cursorAgentId: rawId }).receipt;
    expect(rawReceipt.hostSource?.id, "the receipt carries the raw id").toBe(rawId);
    expect(
      isStoredReceipt(
        { author: CREW, content: rawReceipt.content, hostSource: { host: "cursor", kind: "launch", id: normalizedId } },
        CREW,
        rawReceipt,
      ),
      "the stored (normalised) id verifies against the raw id on the same source",
    ).toBe(true);
  });

  test("a different author, content, source id, a withheld pointer, or no row does NOT match", () => {
    expect(isStoredReceipt(null, CREW, receipt)).toBe(false);
    expect(isStoredReceipt({ author: "agent-b", content: receipt.content, hostSource: receipt.hostSource }, CREW, receipt)).toBe(false);
    expect(isStoredReceipt({ author: CREW, content: "different", hostSource: receipt.hostSource }, CREW, receipt)).toBe(false);
    expect(
      isStoredReceipt(
        { author: CREW, content: receipt.content, hostSource: { host: "cursor", kind: "launch", id: "bc-OTHER" } },
        CREW,
        receipt,
      ),
    ).toBe(false);
    expect(isStoredReceipt({ author: CREW, content: receipt.content, hostSource: "withheld" }, CREW, receipt)).toBe(false);
    expect(isStoredReceipt({ author: CREW, content: receipt.content }, CREW, receipt)).toBe(false);
  });
});

describe("runWakeCycle — a row at the receipt id not verified as this receipt (flair#1944 round 3)", () => {
  const id = launchReceiptId("evt-1");

  test("another agent's memory at the id: no ack, a named mismatch, row untouched", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order, {
      seed: new Map([[id, { content: "an unrelated memory" }]]),
      author: "agent-b",
    });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client, calls } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const result = await runCycle(store, port, client);
    expect(result.items[0].receipt).toBe("mismatched");
    expect(result.receiptMismatched).toContain(id);
    expect(result.receiptMismatched).toContain("agent-b");
    expect(result.receiptFailed).toBeNull();
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    expect(records.get(id)?.content, "the foreign row is left untouched").toBe("an unrelated memory");
    expect(records.size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("this runner's own row at the id with different content: no ack, row untouched", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order, {
      seed: new Map([[id, { content: "a stale receipt naming a different launch" }]]),
    });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "already", cursorAgentId: "bc-1" });
    const result = await runCycle(store, port, client);
    expect(result.items[0].receipt).toBe("mismatched");
    expect(result.receiptMismatched).toContain("content");
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    expect(records.get(id)?.content, "the row is left untouched").toBe("a stale receipt naming a different launch");
  });

  test("this runner's own row with a different host-source id: no ack", async () => {
    const expected = buildLaunchReceipt("evt-1", { cursorAgentId: "bc-1" }).receipt;
    const order: string[] = [];
    const { store } = fakeStore(order, {
      seed: new Map([[id, { content: expected.content, hostSource: { host: "cursor", kind: "launch", id: "bc-OTHER" } }]]),
    });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "already", cursorAgentId: "bc-1" });
    const result = await runCycle(store, port, client);
    expect(result.items[0].receipt).toBe("mismatched");
    expect(result.receiptMismatched).toContain("host source");
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
  });

  test("this runner's own MATCHING receipt: unchanged + ack", async () => {
    const expected = buildLaunchReceipt("evt-1", { cursorAgentId: "bc-1" }).receipt;
    const order: string[] = [];
    const { store } = fakeStore(order, {
      seed: new Map([[id, { content: expected.content, hostSource: expected.hostSource }]]),
    });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "already", cursorAgentId: "bc-1" });
    const result = await runCycle(store, port, client);
    expect(result.items[0].receipt).toBe("unchanged");
    expect(result.receiptMismatched).toBeNull();
    expect(result.acked).toBe("p1");
    expect(acks).toEqual(["p1"]);
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

describe("permanentReceiptRefusal — which receipt write failures are non-retryable (flair#1944)", () => {
  test("400, 409, 413 and 422 are non-retryable, with the status and the named error code", () => {
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

describe("runWakeCycle — a receipt the runner treats as a non-retryable refusal (flair#1944)", () => {
  test("a 400 is acked, reported as receiptRefused with status + code only, and logged once", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order, { writeError: serverError(400, ECHOING_400) });
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1" });
    const lines: string[] = [];
    const result = await runCycle(store, port, client, { log: (line) => lines.push(line) });
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
    const result = await runCycle(store, port, client);
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
      const result = await runCycle(store, port, client);
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
    const result = await runCycle(store, port, client);
    expect(result.receiptFailed).toContain("evt-1");
    expect(result.receiptRefused).toEqual([]);
    expect(order.some((entry) => entry.startsWith("write:"))).toBe(false);
    expect(records.size).toBe(0);
    expect(acks).toEqual([]);
  });
});

describe("runWakeCycle — a `dry-run` outcome in a live cycle is refused (flair#1944 round 7)", () => {
  test("a dry-run launch outcome in a LIVE cycle is refused by name; nothing recorded, nothing acked", async () => {
    // The runner picks the Cursor client from `dryRun`, so a live cycle can only
    // observe a `dry-run` outcome through the test seam — defence in depth.
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "dry-run", cursorAgentId: "bc-1" });
    await expect(runCycle(store, port, client)).rejects.toThrow(/dry-run.*live cycle/);
    expect(acks).toEqual([]);
    expect(order.some((entry) => entry.startsWith("ack:"))).toBe(false);
    expect(order.some((entry) => entry.startsWith("write:"))).toBe(false);
    expect(records.size).toBe(0);
  });
});

describe("runWakeCycle — a LIVE outcome in a dry-run cycle is refused (flair#1944 round 8)", () => {
  test("dryRun with a write-capable client and a `created` result: refused by name BEFORE recordLaunch, no memory written", async () => {
    // The runner picks the Cursor client from `dryRun`, so a dry-run cycle can only
    // observe a live outcome through the internal core's seam — defence in depth in
    // the other direction. A `created`/`already` outcome must be refused, by name,
    // BEFORE `recordLaunch`, so the dry-run cycle writes no receipt and acks nothing.
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const { port, acks } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "created", cursorAgentId: "bc-1", url: "https://cursor.example/agents/bc-1" });
    await expect(runCycle(store, port, client, { dryRun: true })).rejects.toThrow(/dry-run cycle/);
    expect(records.size, "a dry-run cycle writes no receipt").toBe(0);
    expect(order.some((entry) => entry.startsWith("write:")), "no write was ever attempted").toBe(false);
    expect(acks, "a dry-run cycle acks nothing").toEqual([]);
  });

  test("an `already` result in a dry-run cycle is refused by name too; no memory written", async () => {
    const order: string[] = [];
    const { store, records } = fakeStore(order);
    const { port } = catchupWith(order, [{ events: [dispatchEvent()], hasMore: false }]);
    const { client } = cursorReturning({ outcome: "already", cursorAgentId: "bc-1" });
    await expect(runCycle(store, port, client, { dryRun: true })).rejects.toThrow(/already.*dry-run cycle/);
    expect(records.size).toBe(0);
    expect(order.some((entry) => entry.startsWith("write:"))).toBe(false);
  });
});
