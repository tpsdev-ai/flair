import { describe, expect, test } from "bun:test";
import {
  STDIO_TOOL_DESCRIPTORS,
  TOOL_DESCRIPTORS,
  SURFACE_EXEMPTIONS,
  toStdioMcpToolDef,
} from "@tpsdev-ai/flair-tool-descriptors";
import { STDIO_TOOL_HANDLERS } from "../src/adapter-tools.ts";
import { buildCatchupRequest, summarizeCatchup } from "../src/catchup.ts";

const CALLER = "anvil";
const OTHER = "ember";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Minimal FlairClient stub: records every request and answers POST /ack with a
 * thin echo, GET with the configured page. Mirrors the "in isolation" style
 * used by the other adapter-tools tests.
 */
function makeCtx(agentId: string = CALLER, page: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const flair = {
    agentId,
    url: "http://localhost:19926",
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST") {
        return { participantId: agentId, stream: "org-event", position: (body as { position?: string })?.position, advanced: true };
      }
      return page;
    },
  };
  const ctx = { flair, agentId, heartbeat: () => {}, rememberTask: () => {} } as unknown as Parameters<(typeof STDIO_TOOL_HANDLERS)[string]>[1];
  return { ctx, calls };
}

const handler = STDIO_TOOL_HANDLERS.flair_catchup;

describe("flair_catchup descriptor (flair#1583)", () => {
  test("is a stdio-only (native:false) descriptor, exempted from native /mcp", () => {
    const d = STDIO_TOOL_DESCRIPTORS.find((t) => t.name === "flair_catchup");
    expect(d).toBeDefined();
    expect(d!.native).toBe(false);
    expect(SURFACE_EXEMPTIONS.adapterOnly).toContain("flair_catchup");
    // Owner-scope: native /mcp (which would carry an implicit participant) does
    // not advertise it — the stdio adapter is the surface a running agent uses.
    expect(TOOL_DESCRIPTORS.filter((t) => t.native !== false).map((t) => t.name)).not.toContain("flair_catchup");
  });

  test("advertises no agentId/participantId — there is no way to name another feed", () => {
    const d = STDIO_TOOL_DESCRIPTORS.find((t) => t.name === "flair_catchup")!;
    const props = (toStdioMcpToolDef(d).inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("agentId");
    expect(props).not.toHaveProperty("participantId");
    expect(Object.keys(props).sort()).toEqual(["ack", "after", "limit"]);
  });

  test("is bound on the adapter (handler exists) and carries the ack/after contract", () => {
    expect(typeof handler).toBe("function");
    const d = STDIO_TOOL_DESCRIPTORS.find((t) => t.name === "flair_catchup")!;
    const props = (toStdioMcpToolDef(d).inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("after");
    expect(props).toHaveProperty("limit");
    expect(props).toHaveProperty("ack");
  });
});

describe("flair_catchup owner-scope (security boundary)", () => {
  test("reads the CALLER's own feed — spoofed agentId/participantId args are ignored", async () => {
    const { ctx, calls } = makeCtx(CALLER);
    await handler({ agentId: OTHER, participantId: OTHER, after: "cursor" }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path.startsWith(`/OrgEventCatchup/${CALLER}`)).toBe(true);
    expect(calls[0].path).not.toContain(OTHER);
  });

  test("the path participant is the identity, not a body/arg — it tracks ctx.agentId", async () => {
    const { ctx, calls } = makeCtx(OTHER);
    await handler({}, ctx);
    expect(calls[0].path).toBe(`/OrgEventCatchup/${OTHER}`);
  });

  test("an id needing escaping is URL-encoded into the path segment", async () => {
    const { ctx, calls } = makeCtx("a/b");
    await handler({}, ctx);
    expect(calls[0].path).toBe(`/OrgEventCatchup/a%2Fb`);
  });
});

describe("flair_catchup drain + ack", () => {
  test("no args: a single owner-scoped GET, no query, no ack", async () => {
    const { ctx, calls } = makeCtx(CALLER, { events: [], after: "wm", nextAfter: "wm", watermark: "wm", hasMore: false, pageSize: 50 });
    const result = await handler({}, ctx);
    expect(calls).toEqual([{ method: "GET", path: `/OrgEventCatchup/${CALLER}`, body: undefined }]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ events: [], after: "wm", nextAfter: "wm", watermark: "wm", hasMore: false, pageSize: 50 });
  });

  test("after + limit are forwarded as query params", async () => {
    const { ctx, calls } = makeCtx(CALLER, { events: [], after: "c2" });
    await handler({ after: "c1", limit: 10 }, ctx);
    expect(calls[0].path).toBe(`/OrgEventCatchup/${CALLER}?after=c1&limit=10`);
  });

  test("ack POSTs the position to the caller's own path BEFORE the read", async () => {
    const { ctx, calls } = makeCtx(CALLER, { events: [], after: "p3", watermark: "p3" });
    const result = await handler({ ack: "p3" }, ctx);
    expect(calls).toEqual([
      { method: "POST", path: `/OrgEventCatchup/${CALLER}`, body: { position: "p3" } },
      { method: "GET", path: `/OrgEventCatchup/${CALLER}`, body: undefined },
    ]);
    expect(result.structuredContent?.acked).toBe("p3");
    expect(result.content[0].text).toContain(`acked: p3`);
  });

  test("ack with an explicit after pages from that cursor while advancing the watermark", async () => {
    const { ctx, calls } = makeCtx(CALLER, { events: [], after: "old", nextAfter: "new" });
    await handler({ ack: "old", after: "old", limit: 5 }, ctx);
    expect(calls[0]).toEqual({ method: "POST", path: `/OrgEventCatchup/${CALLER}`, body: { position: "old" } });
    expect(calls[1].path).toBe(`/OrgEventCatchup/${CALLER}?after=old&limit=5`);
  });

  test("empty-string after/ack are treated as absent (no empty cursor, no POST)", async () => {
    const { ctx, calls } = makeCtx(CALLER, { events: [], after: "wm" });
    await handler({ after: "", ack: "" }, ctx);
    expect(calls).toEqual([{ method: "GET", path: `/OrgEventCatchup/${CALLER}`, body: undefined }]);
  });
});

describe("flair_catchup idempotency / at-least-once shape", () => {
  test("a repeated read is byte-identical (safe to re-deliver) and re-ack is a verbatim second POST", async () => {
    const page = { events: [{ id: "e1", kind: "status", summary: "s", position: "p1" }], after: "p0", nextAfter: "p1", watermark: "p0", hasMore: false };
    const first = await (async () => {
      const { ctx, calls } = makeCtx(CALLER, page);
      const r = await handler({ ack: "p0" }, ctx);
      return { calls, r };
    })();
    const second = await (async () => {
      const { ctx, calls } = makeCtx(CALLER, page);
      const r = await handler({ ack: "p0" }, ctx);
      return { calls, r };
    })();
    expect(first.calls).toEqual(second.calls);
    expect(first.r.structuredContent?.events).toEqual(second.r.structuredContent?.events);
    // The client never tracks or rewinds state — it forwards the ack verbatim
    // and monotonicity is the server's (advanceReadPosition) guarantee.
    expect(second.calls[0]).toEqual({ method: "POST", path: `/OrgEventCatchup/${CALLER}`, body: { position: "p0" } });
  });

  test("page cursor + hasMore are echoed so the caller can drain", async () => {
    const { ctx } = makeCtx(CALLER, {
      events: [{ id: "e1", kind: "coord.claim", summary: "claim", position: "p1", targetIds: [CALLER] }],
      after: "p0",
      nextAfter: "p1",
      watermark: "p0",
      hasMore: true,
      pageSize: 50,
    });
    const result = await handler({ after: "p0" }, ctx);
    expect(result.structuredContent).toMatchObject({ after: "p0", nextAfter: "p1", hasMore: true });
    expect(result.content[0].text).toContain("more available");
    expect(result.content[0].text).toContain(`after="p1"`);
  });
});

describe("catchup helpers (pure)", () => {
  test("buildCatchupRequest always owner-scopes and trims empty cursors", () => {
    expect(buildCatchupRequest("a b", { after: "", ack: "", limit: Number.NaN })).toEqual({
      path: "/OrgEventCatchup/a%20b",
      getPath: "/OrgEventCatchup/a%20b",
      ackPath: "/OrgEventCatchup/a%20b",
      ackPosition: null,
    });
    const r = buildCatchupRequest("anvil", { after: "x", limit: 3, ack: "y" });
    expect(r.getPath).toBe("/OrgEventCatchup/anvil?after=x&limit=3");
    expect(r.ackPosition).toBe("y");
  });

  test("summarizeCatchup degrades to no-events on an absent page", () => {
    const { text, structuredContent } = summarizeCatchup(undefined, null);
    expect(text).toContain("no new events");
    expect(structuredContent).toEqual({ events: [], after: null, nextAfter: null, watermark: null, hasMore: false });
  });
});
