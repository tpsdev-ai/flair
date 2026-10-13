/**
 * write-result-preview-2467.test.ts — the MCP write tools' replies after a
 * server-side redaction (flair#2467).
 *
 * `memory_store` and `memory_update` build their reply from the write result.
 * When the server reports a redaction, the preview (at most 120 characters)
 * comes only from the stored content the result carries, and the reply
 * reports the count. A result with a positive count and no stored text
 * (`contentWithheld`, from a server that does not return it) gets no preview:
 * the reply states the count and that the stored text was not returned, not
 * which field changed, and never shows the caller's input. A write with no count previews the result's content,
 * else the input: the server reported no replacement.
 *
 * Most cases use a FlairClient stand-in; the last block runs the real SDK over
 * a stand-in fetch. The real-SDK/real-Harper counterpart is
 * test/integration/memory-write-redaction-2407.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FlairClient } from "@tpsdev-ai/flair-client";
import { STDIO_TOOL_HANDLERS } from "../src/adapter-tools.ts";

const AGENT = "agent-a";
const TOKEN = `ghp_${"a".repeat(24)}`;
const ORIGINAL = `deploy note: use token ${TOKEN} for the CI job`;
const STORED = "deploy note: use token [redacted] for the CI job";
/** The reply line for a counted redaction whose stored text was not returned. */
const withheld = (count: number) =>
  `Preview: none. The server redacted ${count} value(s) in this write; the stored text was not returned.`;

function ctxWith(memory: Record<string, unknown>) {
  return {
    flair: { url: "http://flair.invalid", memory } as any,
    agentId: AGENT,
    heartbeat: () => {},
    rememberTask: () => {},
  };
}

describe("flair#2467 — memory_store previews the STORED text and reports the count", () => {
  test("a redacted write previews the stored text, never the caller's input", async () => {
    const memory = { write: async () => ({ id: "mem-1", content: STORED, redactedValues: 1, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_store({ content: ORIGINAL, tags: [] }, ctxWith(memory) as any);
    const text = res.content[0].text;
    expect(text).toContain(`Preview: ${STORED}`);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
    expect(res.structuredContent?.redactedValues).toBe(1);
    expect(res.structuredContent?.contentWithheld).toBeUndefined();
  });

  test("a write the server did not redact previews the input and reports no count", async () => {
    const memory = { write: async () => ({ id: "mem-1", content: ORIGINAL, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_store({ content: ORIGINAL, tags: [] }, ctxWith(memory) as any);
    expect(res.content[0].text).toContain(`Preview: ${ORIGINAL}`);
    expect(res.content[0].text).not.toContain("Redacted");
    expect(res.structuredContent?.redactedValues).toBeUndefined();
  });

  test("a counted redaction with the content withheld has no preview and no input text", async () => {
    const memory = { write: async () => ({ id: "mem-1", redactedValues: 1, contentWithheld: true, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_store({ content: ORIGINAL, tags: [] }, ctxWith(memory) as any);
    const text = res.content[0].text;
    expect(text).toContain(withheld(1));
    expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("deploy note");
    expect(text).not.toContain("Size:");
    expect(res.structuredContent?.redactedValues).toBe(1);
    expect(res.structuredContent?.contentWithheld).toBe(true);
  });

  test("a counted redaction whose result has no content string is withheld too", async () => {
    const memory = { write: async () => ({ id: "mem-1", redactedValues: 2, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_store({ content: ORIGINAL, tags: [] }, ctxWith(memory) as any);
    expect(res.content[0].text).toContain(withheld(2));
    expect(res.content[0].text).not.toContain(TOKEN);
    expect(res.structuredContent?.contentWithheld).toBe(true);
  });
});

describe("flair#2467 — memory_update previews the STORED text and reports the count", () => {
  test("a redacted update previews the stored text and reports the count", async () => {
    const memory = { update: async () => ({ id: "mem-1", content: STORED, redactedValues: 1, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_update({ id: "mem-1", content: ORIGINAL }, ctxWith(memory) as any);
    const text = res.content[0].text;
    expect(text).toContain("Memory updated (id: mem-1).");
    expect(text).toContain(`Preview: ${STORED}`);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
    expect(res.structuredContent?.redactedValues).toBe(1);
  });

  test("an update the server did not redact reports no count", async () => {
    const memory = { update: async () => ({ id: "mem-1", content: ORIGINAL, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_update({ id: "mem-1", content: ORIGINAL }, ctxWith(memory) as any);
    expect(res.content[0].text).not.toContain("Redacted");
    expect(res.structuredContent?.redactedValues).toBeUndefined();
  });

  test("a counted redaction with the content withheld has no preview and no input text", async () => {
    const memory = { update: async () => ({ id: "mem-2", redactedValues: 1, contentWithheld: true, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_update(
      { id: "mem-1", content: ORIGINAL, preserveHistory: true }, ctxWith(memory) as any,
    );
    const text = res.content[0].text;
    expect(text).toContain("Memory updated: new version stored (id: mem-2), supersedes mem-1.");
    expect(text).toContain(withheld(1));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("deploy note");
    expect(res.structuredContent?.contentWithheld).toBe(true);
  });
});

describe("flair#2467 — the real SDK over an older server's response: the MCP reply holds no input text", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A server from before `stored`: a redacting PUT answers with the count only. */
  function olderServerClient(existing: Record<string, unknown> = {}): FlairClient {
    globalThis.fetch = (async (input: any, init?: any) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      if (method === "PUT") {
        const id = decodeURIComponent(path.replace(/^\/Memory\//, ""));
        return Response.json({ id, written: true, deduplicated: false, redactedValues: 1 });
      }
      if (method === "GET") {
        return Response.json({ id: "mem-1", agentId: AGENT, content: "old text", type: "session", durability: "standard", tags: [], ...existing });
      }
      throw new Error(`unexpected ${method} ${path}`);
    }) as any;
    const { privateKey } = generateKeyPairSync("ed25519");
    return new FlairClient({ agentId: AGENT, url: "http://flair.invalid", privateKey });
  }

  test("memory_store", async () => {
    const flair = olderServerClient();
    const res = await STDIO_TOOL_HANDLERS.memory_store({ content: ORIGINAL, tags: [] }, { ...ctxWith({}), flair } as any);
    const text = res.content[0].text;
    expect(text).toContain(withheld(1));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("deploy note");
    expect(res.structuredContent?.contentWithheld).toBe(true);
  });

  test("memory_update", async () => {
    const flair = olderServerClient();
    const res = await STDIO_TOOL_HANDLERS.memory_update({ id: "mem-1", content: ORIGINAL }, { ...ctxWith({}), flair } as any);
    const text = res.content[0].text;
    expect(text).toContain(withheld(1));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("deploy note");
    expect(res.structuredContent?.contentWithheld).toBe(true);
  });

  test("a summary-only redaction: the reply states the count, not that the content was redacted", async () => {
    // The update's plain content is stored as written; only the existing
    // row's summary carries a credential-shaped value.
    const flair = olderServerClient({ summary: `old summary ${TOKEN}` });
    const plain = "a plain note with nothing to redact";
    const res = await STDIO_TOOL_HANDLERS.memory_update({ id: "mem-1", content: plain }, { ...ctxWith({}), flair } as any);
    const text = res.content[0].text;
    expect(text).toContain(withheld(1));
    expect(text).not.toContain("redacted this content");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(plain);
    expect(res.structuredContent?.redactedValues).toBe(1);
    expect(res.structuredContent?.contentWithheld).toBe(true);
  });
});
