/**
 * Unit tests for the OllamaLlm test helper's request mapping.
 *
 * flair#1122: unmapped LlmRequest part kinds must throw, not silently
 * become an empty string. The helper is text-only on purpose; a future
 * tool-calling test has to notice immediately.
 */

import { describe, it, expect } from "bun:test";
import type { Part } from "@google/genai";
import { extractText } from "../helpers/ollama-llm.js";

describe("OllamaLlm extractText (flair#1122)", () => {
  it("returns text from a text part", () => {
    expect(extractText({ text: "hello" })).toBe("hello");
  });

  it("returns empty string for an empty text part", () => {
    expect(extractText({ text: "" })).toBe("");
    expect(extractText({})).toBe("");
  });

  it("allows thought metadata on a text part", () => {
    expect(extractText({ text: "thinking", thought: true })).toBe("thinking");
  });

  it("throws on functionCall instead of silent empty-string", () => {
    const part = { functionCall: { name: "search", args: {} } } as Part;
    expect(() => extractText(part)).toThrow(/unmapped LlmRequest part kind "functionCall"/);
  });

  it("throws on functionResponse instead of silent empty-string", () => {
    const part = {
      functionResponse: { name: "search", response: { ok: true } },
    } as Part;
    expect(() => extractText(part)).toThrow(/unmapped LlmRequest part kind "functionResponse"/);
  });

  it("throws when a text part is mixed with an unmapped kind", () => {
    const part = {
      text: "also a call",
      functionCall: { name: "search", args: {} },
    } as Part;
    expect(() => extractText(part)).toThrow(/unmapped LlmRequest part kind "functionCall"/);
  });
});
