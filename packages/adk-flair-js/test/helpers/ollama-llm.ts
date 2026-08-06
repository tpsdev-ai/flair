/**
 * Minimal Ollama LLM adapter for adk-flair-js integration tests.
 *
 * @google/adk v1.6.0 ships only Gemini and ApigeeLlm in its model registry.
 * When ADK_TEST_MODEL=ollama_chat/<model> is set, this helper registers an
 * OllamaLlm class that speaks plain /api/chat completions against
 * OLLAMA_API_BASE (default http://localhost:11434).
 *
 * The ollama_chat/ prefix is stripped to derive the Ollama model name.
 * No tool/function-calling support — the quickstart-parity agent loop only
 * uses PreloadMemoryTool (a processor-level tool that never reaches the
 * model), so plain chat completions are sufficient.
 *
 * Non-streaming only. Streaming is not needed for the integration tests.
 *
 * Usage (in a test file's beforeAll or at module scope):
 *
 *   import { registerOllamaLlm } from "../helpers/ollama-llm.js";
 *   registerOllamaLlm();
 */

import { BaseLlm, LLMRegistry } from "@google/adk";
import type { LlmRequest, LlmResponse } from "@google/adk";
import type { Content, Part } from "@google/genai";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractText(part: Part): string {
  if (part.text) return part.text;
  return "";
}

function contentToOllamaMessage(
  content: Content,
): { role: string; content: string } | null {
  const parts = content.parts ?? [];
  const text = parts.map(extractText).join("").trim();
  if (!text) return null;

  const role = content.role === "model" ? "assistant" : "user";
  return { role, content: text };
}

function extractSystemInstruction(
  config: LlmRequest["config"],
): string | null {
  if (!config?.systemInstruction) return null;
  const si = config.systemInstruction;
  // ContentUnion: Content | PartUnion[] | PartUnion
  if (Array.isArray(si)) {
    return si.map(extractText).join("").trim() || null;
  }
  if (typeof si === "object" && "parts" in si) {
    const parts = (si as Content).parts ?? [];
    return parts.map(extractText).join("").trim() || null;
  }
  if (typeof si === "object" && "text" in si) {
    return (si as Part).text?.trim() ?? null;
  }
  return null;
}

// ─── OllamaLlm ──────────────────────────────────────────────────────────────

const OLLAMA_PREFIX = "ollama_chat/";

export class OllamaLlm extends BaseLlm {
  /** Regex matching the ollama_chat/ prefix for LLMRegistry resolution. */
  static readonly supportedModels: Array<string | RegExp> = [/^ollama_chat\//];

  private readonly ollamaModel: string;

  constructor({ model }: { model: string }) {
    super({ model });
    if (!model.startsWith(OLLAMA_PREFIX)) {
      throw new Error(
        `OllamaLlm: model must start with "${OLLAMA_PREFIX}", got "${model}"`,
      );
    }
    this.ollamaModel = model.slice(OLLAMA_PREFIX.length);
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse> {
    const apiBase =
      process.env["OLLAMA_API_BASE"] ?? "http://localhost:11434";
    const url = `${apiBase}/api/chat`;

    // Build Ollama chat messages from LlmRequest contents
    const messages: Array<{ role: string; content: string }> = [];

    // System instruction → system message
    const systemInstruction = extractSystemInstruction(llmRequest.config);
    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }

    // Contents → user/assistant messages
    for (const content of llmRequest.contents) {
      const msg = contentToOllamaMessage(content);
      if (msg) messages.push(msg);
    }

    const body = JSON.stringify({
      model: this.ollamaModel,
      messages,
      stream: false,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: abortSignal ?? null,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      yield {
        errorCode: String(resp.status),
        errorMessage: `Ollama API error ${resp.status}: ${text.slice(0, 500)}`,
      };
      return;
    }

    const data = (await resp.json()) as {
      message?: { role?: string; content?: string };
    };

    const replyText = data.message?.content ?? "";

    yield {
      content: {
        role: "model",
        parts: [{ text: replyText }],
      },
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<never> {
    throw new Error("OllamaLlm does not support live/bidi connections");
  }
}

// ─── Registration ───────────────────────────────────────────────────────────

let _registered = false;

/**
 * Register OllamaLlm in the adk LLMRegistry for the ollama_chat/ prefix.
 *
 * Idempotent — safe to call multiple times (e.g. from beforeAll hooks).
 */
export function registerOllamaLlm(): void {
  if (_registered) return;
  LLMRegistry.register(OllamaLlm);
  _registered = true;
}
