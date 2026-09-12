import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCreateBody,
  buildWakeName,
  buildWakePrompt,
  catchupGetPath,
  catchupPath,
  classifyDispatch,
  createCatchupPort,
  createCursorAgentClient,
  DISPATCH_KINDS,
  extractPointer,
  HELP,
  isAgentIdConflict,
  isDirectedAt,
  isDispatchKind,
  isWakeAgentId,
  loadConfig,
  parseArgs,
  runWakeCycle,
  uuidv5,
  DNS_NAMESPACE,
  wakeAgentId,
  type CatchupPage,
  type CatchupPort,
  type CursorAgentClient,
  type LaunchInput,
  type LaunchResult,
} from "../src/index.ts";

const CREW = "anvil";
const OTHER = "ember";

function dispatchEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "flint-2026-09-12T17:00:00.000Z",
    kind: "coord.dispatch",
    summary: "Ship the wake-runner",
    detail: "https://github.com/tpsdev-ai/flair/issues/1613 light brief",
    targetIds: [CREW],
    authorId: "flint",
    position: "p1",
    ...overrides,
  };
}

describe("uuid v5 (RFC 4122 vector)", () => {
  test("DNS + www.example.com matches the published vector", () => {
    expect(uuidv5("www.example.com", DNS_NAMESPACE)).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
});

describe("wakeAgentId — single-launch key", () => {
  test("is a bc- UUID v5, stable for the same OrgEvent id, distinct across ids", () => {
    const a = wakeAgentId("flint-2026-09-12T17:00:00.000Z");
    const b = wakeAgentId("flint-2026-09-12T17:00:00.000Z");
    const c = wakeAgentId("flint-2026-09-12T17:00:01.000Z");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isWakeAgentId(a)).toBe(true);
    expect(isWakeAgentId("bc-not-a-uuid")).toBe(false);
  });

  test("refuses an empty event id — that cannot be idempotent", () => {
    expect(() => wakeAgentId("")).toThrow("non-empty");
  });
});

describe("classifyDispatch — directed only, owner-scoped", () => {
  test("coord.dispatch and a2a.message targeting this agent are dispatches", () => {
    expect(isDispatchKind("coord.dispatch")).toBe(true);
    expect(isDispatchKind("a2a.message")).toBe(true);
    expect(DISPATCH_KINDS).toEqual(["coord.dispatch", "a2a.message"]);
    expect(classifyDispatch(dispatchEvent(), CREW)?.id).toBe("flint-2026-09-12T17:00:00.000Z");
    expect(classifyDispatch(dispatchEvent({ kind: "a2a.message" }), CREW)?.kind).toBe("a2a.message");
  });

  test("broadcast (empty targetIds) and someone else's target are not a wake", () => {
    expect(isDirectedAt({ targetIds: [] }, CREW)).toBe(false);
    expect(isDirectedAt({ targetIds: [OTHER] }, CREW)).toBe(false);
    expect(classifyDispatch(dispatchEvent({ targetIds: [] }), CREW)).toBeNull();
    expect(classifyDispatch(dispatchEvent({ targetIds: [OTHER] }), CREW)).toBeNull();
    expect(classifyDispatch(dispatchEvent({ kind: "coord.claim" }), CREW)).toBeNull();
    expect(classifyDispatch(dispatchEvent({ id: "" }), CREW)).toBeNull();
  });

  test("pointer prefers refId, then a GitHub URL in detail; PR sets prUrl", () => {
    expect(extractPointer(dispatchEvent()).pointer).toBe("https://github.com/tpsdev-ai/flair/issues/1613");
    expect(extractPointer(dispatchEvent()).repoUrl).toBe("https://github.com/tpsdev-ai/flair");
    const pr = extractPointer({
      refId: "https://github.com/tpsdev-ai/flair/pull/1612",
      detail: "merged catchup",
    });
    expect(pr.prUrl).toBe("https://github.com/tpsdev-ai/flair/pull/1612");
    expect(extractPointer({ refId: "flair-abc" }).pointer).toBe("flair-abc");
  });

  test("prompt stays light — pointer + one-line brief, no board rebuild", () => {
    const d = classifyDispatch(dispatchEvent(), CREW)!;
    const prompt = buildWakePrompt(d, CREW);
    expect(prompt).toContain("Ship the wake-runner");
    expect(prompt).toContain("https://github.com/tpsdev-ai/flair/issues/1613");
    expect(prompt).toContain("Do not rebuild a message board");
    expect(buildWakeName(d).startsWith("wake:")).toBe(true);
    expect(buildWakeName(d).length).toBeLessThanOrEqual(100);
  });
});

describe("catchup port — owner-scope by construction", () => {
  test("path is always the signed agent; there is no participant argument", () => {
    expect(catchupPath(CREW)).toBe(`/OrgEventCatchup/${CREW}`);
    expect(catchupPath("a/b")).toBe("/OrgEventCatchup/a%2Fb");
    expect(catchupGetPath(CREW, "p0", 10)).toBe(`/OrgEventCatchup/${CREW}?after=p0&limit=10`);
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const port = createCatchupPort({
      agentId: CREW,
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        return { events: [] };
      },
    });
    // The port function signature has no participantId — TypeScript enforces
    // this; at runtime a spoofed third arg is ignored.
    void (port.drain as (after?: string, limit?: number, spoofed?: string) => Promise<CatchupPage>)(
      undefined,
      undefined,
      OTHER,
    );
    expect(calls[0]?.path).toBe(`/OrgEventCatchup/${CREW}`);
    expect(calls[0]?.path).not.toContain(OTHER);
  });

  test("refuses to bind without an identity", () => {
    expect(() => createCatchupPort({ agentId: "", request: async () => ({}) })).toThrow("FLAIR_AGENT_ID");
  });
});

describe("Cursor create body + 409", () => {
  test("create body carries the deterministic agentId and never envVars", () => {
    const dispatch = classifyDispatch(dispatchEvent(), CREW)!;
    const body = buildCreateBody(
      { cursorAgentId: wakeAgentId(dispatch.id), dispatch, crewAgentId: CREW },
      { apiBase: "https://api.cursor.com", apiKey: "k", startingRef: "main" },
    );
    expect(body.agentId).toBe(wakeAgentId(dispatch.id));
    expect(body).not.toHaveProperty("envVars");
    expect((body.repos as Array<{ url: string }>)[0].url).toBe("https://github.com/tpsdev-ai/flair");
  });

  test("named env wins over repos (API mutual exclusion)", () => {
    const dispatch = classifyDispatch(dispatchEvent(), CREW)!;
    const body = buildCreateBody(
      { cursorAgentId: wakeAgentId(dispatch.id), dispatch, crewAgentId: CREW },
      { apiBase: "https://api.cursor.com", apiKey: "k", envName: "flair-dev", repoUrl: "https://example.com/x" },
    );
    expect(body.env).toEqual({ type: "cloud", name: "flair-dev" });
    expect(body.repos).toBeUndefined();
  });

  test("only agent_id_conflict 409 is idempotent success", () => {
    expect(isAgentIdConflict(409, { error: "agent_id_conflict" })).toBe(true);
    expect(isAgentIdConflict(409, "")).toBe(true);
    expect(isAgentIdConflict(409, { error: "another_run_active" })).toBe(false);
    expect(isAgentIdConflict(201, { error: "agent_id_conflict" })).toBe(false);
  });

  test("create client maps 201 → created and 409 agent_id_conflict → already", async () => {
    const dispatch = classifyDispatch(dispatchEvent(), CREW)!;
    const input: LaunchInput = { cursorAgentId: wakeAgentId(dispatch.id), dispatch, crewAgentId: CREW };
    const created = createCursorAgentClient(
      { apiBase: "https://api.cursor.com", apiKey: "k" },
      (async () =>
        new Response(JSON.stringify({ agent: { id: input.cursorAgentId, url: "https://cursor.com/agents/x" } }), {
          status: 201,
        })) as typeof fetch,
    );
    expect(await created.create(input)).toEqual({
      outcome: "created",
      cursorAgentId: input.cursorAgentId,
      url: "https://cursor.com/agents/x",
    });

    const reused = createCursorAgentClient(
      { apiBase: "https://api.cursor.com", apiKey: "k" },
      (async () => new Response(JSON.stringify({ error: "agent_id_conflict" }), { status: 409 })) as typeof fetch,
    );
    expect(await reused.create(input)).toEqual({ outcome: "already", cursorAgentId: input.cursorAgentId });

    const boom = createCursorAgentClient(
      { apiBase: "https://api.cursor.com", apiKey: "k" },
      (async () => new Response("nope", { status: 500 })) as typeof fetch,
    );
    await expect(boom.create(input)).rejects.toThrow("500");
  });
});

function memoryCatchup(pages: CatchupPage[]): { port: CatchupPort; acks: string[]; drains: number } {
  const acks: string[] = [];
  let drains = 0;
  let i = 0;
  const port: CatchupPort = {
    drain: async () => {
      drains += 1;
      return pages[Math.min(i++, pages.length - 1)] ?? { events: [], hasMore: false };
    },
    ack: async (position) => {
      acks.push(position);
    },
  };
  return { port, acks, get drains() { return drains; } };
}

function recordingCursor(handler: (input: LaunchInput) => Promise<LaunchResult> | LaunchResult): {
  client: CursorAgentClient;
  calls: LaunchInput[];
} {
  const calls: LaunchInput[] = [];
  return {
    calls,
    client: {
      create: async (input) => {
        calls.push(input);
        return handler(input);
      },
    },
  };
}

describe("runWakeCycle — drain, launch, ack, no double-launch", () => {
  test("directed dispatch is launched, then the watermark is acked", async () => {
    const event = dispatchEvent();
    const { port, acks } = memoryCatchup([{ events: [event], nextAfter: "p1", hasMore: false }]);
    const { client, calls } = recordingCursor((input) => ({
      outcome: "created",
      cursorAgentId: input.cursorAgentId,
      url: "https://cursor.com/agents/" + input.cursorAgentId,
    }));
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client });
    expect(result.launched).toBe(1);
    expect(result.acked).toBe("p1");
    expect(acks).toEqual(["p1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cursorAgentId).toBe(wakeAgentId(String(event.id)));
  });

  test("redelivery of the same event reuses the Cursor agent (409) and still acks — no second create intent", async () => {
    const event = dispatchEvent();
    const page: CatchupPage = { events: [event], nextAfter: "p1", hasMore: false };
    const first = memoryCatchup([page]);
    const second = memoryCatchup([page]);
    const seen = new Set<string>();
    const handler = (input: LaunchInput): LaunchResult => {
      if (seen.has(input.cursorAgentId)) return { outcome: "already", cursorAgentId: input.cursorAgentId };
      seen.add(input.cursorAgentId);
      return { outcome: "created", cursorAgentId: input.cursorAgentId };
    };
    const a = recordingCursor(handler);
    const b = recordingCursor(handler);
    const one = await runWakeCycle({ agentId: CREW, catchup: first.port, cursor: a.client });
    const two = await runWakeCycle({ agentId: CREW, catchup: second.port, cursor: b.client });
    expect(one.launched).toBe(1);
    expect(two.launched).toBe(0);
    expect(two.reused).toBe(1);
    expect(a.calls[0].cursorAgentId).toBe(b.calls[0].cursorAgentId);
    expect(two.acked).toBe("p1");
  });

  test("re-drain after ack sees an empty page and does not launch", async () => {
    const { port } = memoryCatchup([{ events: [], watermark: "p1", hasMore: false }]);
    const { client, calls } = recordingCursor(() => {
      throw new Error("should not launch");
    });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client });
    expect(result.drained).toBe(0);
    expect(result.launched).toBe(0);
    expect(result.acked).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("broadcast and foreign-target events are skipped (consumed) without a launch", async () => {
    const { port, acks } = memoryCatchup([
      {
        events: [
          dispatchEvent({ id: "b1", kind: "status", targetIds: [], position: "p1" }),
          dispatchEvent({ id: "b2", targetIds: [OTHER], position: "p2" }),
        ],
        hasMore: false,
      },
    ]);
    const { client, calls } = recordingCursor(() => {
      throw new Error("should not launch");
    });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client });
    expect(result.skipped).toBe(2);
    expect(result.launched).toBe(0);
    expect(result.acked).toBe("p2");
    expect(acks).toEqual(["p2"]);
    expect(calls).toHaveLength(0);
  });

  test("a failed launch does not ack that event or anything after it", async () => {
    const { port, acks } = memoryCatchup([
      {
        events: [
          dispatchEvent({ id: "ok", position: "p1" }),
          dispatchEvent({ id: "fail", position: "p2", detail: "https://github.com/tpsdev-ai/flair/issues/1" }),
        ],
        hasMore: false,
      },
    ]);
    const { client } = recordingCursor((input) => {
      if (input.dispatch.id === "fail") throw new Error("cursor down");
      return { outcome: "created", cursorAgentId: input.cursorAgentId };
    });
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client });
    expect(result.launched).toBe(1);
    expect(result.blocked).toContain("fail");
    expect(result.acked).toBe("p1");
    expect(acks).toEqual(["p1"]);
  });

  test("a directed dispatch without an id is BLOCKED, not launched, and does not skip-ack past it", async () => {
    const { port, acks } = memoryCatchup([
      {
        events: [dispatchEvent({ id: "", position: "p-bad" })],
        hasMore: false,
      },
    ]);
    const { client, calls } = recordingCursor(() => ({ outcome: "created", cursorAgentId: "nope" }));
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client });
    expect(result.blocked).toMatch(/missing an id/);
    expect(result.launched).toBe(0);
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("dry-run classifies and does not ack or create", async () => {
    const { port, acks } = memoryCatchup([{ events: [dispatchEvent()], hasMore: false }]);
    const { client, calls } = recordingCursor((input) => ({
      outcome: "dry-run",
      cursorAgentId: input.cursorAgentId,
    }));
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client, dryRun: true });
    expect(result.items[0]?.action).toBe("dry-run");
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("pages until hasMore is false", async () => {
    const { port } = memoryCatchup([
      { events: [dispatchEvent({ id: "e1", position: "p1" })], nextAfter: "p1", hasMore: true },
      { events: [dispatchEvent({ id: "e2", position: "p2" })], nextAfter: "p2", hasMore: false },
    ]);
    const { client, calls } = recordingCursor((input) => ({
      outcome: "created",
      cursorAgentId: input.cursorAgentId,
    }));
    const result = await runWakeCycle({ agentId: CREW, catchup: port, cursor: client });
    expect(result.launched).toBe(2);
    expect(result.acked).toBe("p2");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.cursorAgentId)).size).toBe(2);
  });
});

describe("cli flags + env", () => {
  test("parseArgs: --once is default; --interval disables once", () => {
    expect(parseArgs([])).toEqual({ once: true, intervalSec: null, dryRun: false, help: false });
    expect(parseArgs(["--interval", "60"]).intervalSec).toBe(60);
    expect(parseArgs(["--interval", "60"]).once).toBe(false);
    expect(parseArgs(["--dry-run", "--limit", "5"])).toMatchObject({ dryRun: true, limit: 5 });
    expect(() => parseArgs(["--participant", OTHER])).toThrow("unknown flag");
    expect(() => parseArgs(["--agent", OTHER])).toThrow("unknown flag");
    expect(HELP).toContain("no --participant flag");
    expect(HELP).toContain("bc-<uuid v5>");
  });

  test("loadConfig is owner-scoped and refuses a missing identity / key", () => {
    const saved = { ...process.env };
    const restore = () => {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    };
    try {
      delete process.env.FLAIR_AGENT_ID;
      delete process.env.CURSOR_API_KEY;
      expect(() => loadConfig(parseArgs([]))).toThrow("FLAIR_AGENT_ID");
      process.env.FLAIR_AGENT_ID = CREW;
      expect(() => loadConfig(parseArgs([]))).toThrow("CURSOR_API_KEY");
      expect(loadConfig(parseArgs(["--dry-run"])).agentId).toBe(CREW);
      expect(loadConfig(parseArgs(["--dry-run"]))).not.toHaveProperty("participant");
    } finally {
      restore();
    }
  });
});
