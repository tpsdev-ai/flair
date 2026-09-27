import { describe, expect, test } from "bun:test";
import { STDIO_TOOL_HANDLERS } from "../src/adapter-tools.ts";

/**
 * flair#1970 — the stdio adapter tools that build their OWN `/Memory/<id>`
 * path (rather than going through a flair-client wrapper) must percent-encode
 * the id as ONE path segment, exactly as flair-client has since #1969.
 *
 * skill_store is the adapter-tools site (#1970 item 4). Its record id is
 * `${flair.agentId}-${uuid}`; an agent id carrying reserved URL characters
 * must still reach the wire as one segment that decodes back to the id — no
 * query, no fragment. Pre-#1970 the raw id was interpolated into the path, so
 * `#` truncated it, `?` started a query and `/` split it into extra segments.
 */

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function makeCtx(agentId: string) {
  const calls: Call[] = [];
  const flair = {
    agentId,
    url: "http://localhost:19926",
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body: body as Record<string, unknown> });
      return { id: (body as { id?: string })?.id, written: true };
    },
  };
  const ctx = { flair, agentId, heartbeat: () => {}, rememberTask: () => {} } as unknown as Parameters<
    (typeof STDIO_TOOL_HANDLERS)[string]
  >[1];
  return { ctx, calls };
}

const handler = STDIO_TOOL_HANDLERS.skill_store;

describe("skill_store PUT path percent-encodes the Memory id (#1970)", () => {
  test("an id with reserved URL characters reaches the wire as exactly one segment", async () => {
    const agentId = "ag#1?x/y%z w";
    const { ctx, calls } = makeCtx(agentId);

    const result = await handler({ content: "procedure", name: "p" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);

    const [call] = calls;
    expect(call.method).toBe("PUT");
    const id = call.body!.id as string;
    expect(id.startsWith(agentId)).toBe(true); // the reserved chars really are in the id

    const u = new URL(call.path, "http://placeholder.local");
    const parts = u.pathname.split("/").filter(Boolean);
    expect(parts.length).toBe(2); // assertion: /Memory/<one segment>
    expect(parts[0]).toBe("Memory");
    expect(u.search).toBe("");
    expect(u.hash).toBe("");
    expect(decodeURIComponent(parts[1])).toBe(id);
  });
});
