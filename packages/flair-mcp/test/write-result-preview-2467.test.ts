/**
 * write-result-preview-2467.test.ts — the MCP write tools' replies after a
 * server-side redaction (flair#2467).
 *
 * `memory_store` and `memory_update` build their reply from the write result.
 * When the server redacted a credential-shaped value, the reply must preview
 * the STORED text (not the caller's input) and report the redacted count.
 * The FlairClient is a stand-in here; the real-SDK/real-Harper counterpart is
 * test/integration/memory-write-redaction-2407.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { STDIO_TOOL_HANDLERS } from "../src/adapter-tools.ts";

const AGENT = "agent-a";
const TOKEN = `ghp_${"a".repeat(24)}`;
const ORIGINAL = `deploy note: use token ${TOKEN} for the CI job`;
const STORED = "deploy note: use token [redacted] for the CI job";

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
  });

  test("a write the server did not redact previews the input and reports no count", async () => {
    const memory = { write: async () => ({ id: "mem-1", content: ORIGINAL, written: true }) };
    const res = await STDIO_TOOL_HANDLERS.memory_store({ content: ORIGINAL, tags: [] }, ctxWith(memory) as any);
    expect(res.content[0].text).toContain(`Preview: ${ORIGINAL}`);
    expect(res.content[0].text).not.toContain("Redacted");
    expect(res.structuredContent?.redactedValues).toBeUndefined();
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
});
