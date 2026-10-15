/**
 * write-result-preview-2467.test.ts — the MCP write tools' replies after a
 * server-side redaction (flair#2467).
 *
 * `memory_store` and `memory_update` build their reply from the write result.
 * The preview is the first 120 characters of the selected text, followed by
 * `...` when truncated. When the server reports a redaction, that text is only
 * the stored content the result carries, and the reply reports the count. A
 * result with a positive count and no stored text (`contentWithheld`, from a
 * server that does not return it) gets no preview: the reply states the count
 * and that the stored text was not returned, not which field changed, and
 * never shows the caller's input. With no count (the server reported no
 * replacement), the text is the result's content, else the input.
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

describe("flair#2541 — skill_store previews the STORED text and trigger and reports the count", () => {
  const TRIGGER = `when a job needs ${TOKEN}`;
  const STORED_TRIGGER = "when a job needs [redacted]";
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A FlairClient stand-in whose raw PUT /Memory answers with `response`. */
  function skillCtx(response: Record<string, unknown>) {
    const flair = {
      url: "http://flair.invalid",
      agentId: AGENT,
      request: async (method: string, path: string) => {
        if (method !== "PUT" || !path.startsWith("/Memory/")) throw new Error(`unexpected ${method} ${path}`);
        return response;
      },
    };
    return { ...ctxWith({}), flair } as any;
  }

  test("a redacted write previews the stored content and trigger, never the caller's input", async () => {
    const res = await STDIO_TOOL_HANDLERS.skill_store(
      { content: ORIGINAL, trigger: TRIGGER, name: "deploy" },
      skillCtx({ id: "skill-1", written: true, redactedValues: 2, stored: { content: STORED, trigger: STORED_TRIGGER, name: "deploy" } }),
    );
    const text = res.content[0].text;
    expect(text).toContain("Skill stored (id: skill-1)");
    expect(text).toContain(`Preview: ${STORED}`);
    expect(text).toContain(`Trigger: ${STORED_TRIGGER}`);
    expect(text).toContain("Name: deploy");
    expect(text).toContain("Redacted 2 credential-shaped value(s) before storing.");
    expect(text).not.toContain(TOKEN);
    expect(res.structuredContent).toEqual({ id: "skill-1", written: true, redactedValues: 2 });
  });

  test("flair#2575 — the name line comes from the stored name, never the caller's input", async () => {
    const res = await STDIO_TOOL_HANDLERS.skill_store(
      { content: ORIGINAL, trigger: TRIGGER, name: `deploy ${TOKEN}` },
      skillCtx({ id: "skill-1", written: true, redactedValues: 2, stored: { content: STORED, trigger: STORED_TRIGGER, name: "deploy [redacted]" } }),
    );
    const text = res.content[0].text;
    expect(text).toContain("Name: deploy [redacted]");
    expect(text).not.toContain(TOKEN);
  });

  test("flair#2575 — a counted redaction whose stored text carries no name omits the name line", async () => {
    const res = await STDIO_TOOL_HANDLERS.skill_store(
      { content: ORIGINAL, trigger: TRIGGER, name: `deploy ${TOKEN}` },
      skillCtx({ id: "skill-1", written: true, redactedValues: 2, stored: { content: STORED, trigger: STORED_TRIGGER } }),
    );
    const text = res.content[0].text;
    expect(text).not.toContain("Name:");
    expect(text).not.toContain(TOKEN);
  });

  test("a counted redaction whose stored text carries no trigger omits the trigger line", async () => {
    const res = await STDIO_TOOL_HANDLERS.skill_store(
      { content: ORIGINAL, trigger: TRIGGER },
      skillCtx({ id: "skill-1", written: true, redactedValues: 2, stored: { content: STORED } }),
    );
    const text = res.content[0].text;
    expect(text).toContain(`Preview: ${STORED}`);
    expect(text).not.toContain("Trigger:");
    expect(text).not.toContain(TOKEN);
    expect(res.structuredContent).toEqual({ id: "skill-1", written: true, redactedValues: 2 });
  });

  test("a counted redaction with no stored text has no preview, no trigger line and no input text", async () => {
    for (const response of [
      { id: "skill-1", written: true, redactedValues: 1 },
      { id: "skill-1", written: true, redactedValues: 1, stored: { trigger: STORED_TRIGGER } },
    ]) {
      const res = await STDIO_TOOL_HANDLERS.skill_store({ content: ORIGINAL, trigger: TRIGGER }, skillCtx(response));
      const text = res.content[0].text;
      expect(text).toContain(withheld(1));
      expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
      expect(text).not.toContain("Trigger:");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("deploy note");
      expect(text).not.toContain("when a job");
      expect(res.structuredContent).toEqual({ id: "skill-1", written: true, redactedValues: 1, contentWithheld: true });
    }
  });

  test("a write the server did not redact previews the input and trigger and reports no count", async () => {
    const plain = "a plain skill body";
    const res = await STDIO_TOOL_HANDLERS.skill_store(
      { content: plain, trigger: "when deploying", name: "deploy" },
      skillCtx({ id: "skill-1", written: true, deduplicated: false }),
    );
    expect(res.content[0].text).toBe(
      ["Skill stored (id: skill-1)", `Preview: ${plain}`, "Name: deploy", "Trigger: when deploying"].join("\n"),
    );
    expect(res.structuredContent).toEqual({ id: "skill-1", written: true });
  });

  test("the real SDK: the raw PUT response's `stored` is what the reply shows", async () => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      if (method !== "PUT") throw new Error(`unexpected ${method} ${path}`);
      const id = decodeURIComponent(path.replace(/^\/Memory\//, ""));
      return Response.json({ id, written: true, redactedValues: 2, stored: { content: STORED, trigger: STORED_TRIGGER } });
    }) as any;
    const { privateKey } = generateKeyPairSync("ed25519");
    const flair = new FlairClient({ agentId: AGENT, url: "http://flair.invalid", privateKey });
    const res = await STDIO_TOOL_HANDLERS.skill_store({ content: ORIGINAL, trigger: TRIGGER }, { ...ctxWith({}), flair } as any);
    const text = res.content[0].text;
    expect(text).toContain(`Preview: ${STORED}`);
    expect(text).toContain(`Trigger: ${STORED_TRIGGER}`);
    expect(text).not.toContain(TOKEN);
    expect(res.structuredContent?.redactedValues).toBe(2);
    expect(res.structuredContent?.contentWithheld).toBeUndefined();
  });
});
