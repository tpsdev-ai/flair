/**
 * Minimal Ollama LLM adapter for adk-flair-js integration tests.
 *
 * @google/adk v1.6.0 ships only Gemini and ApigeeLlm in its model registry.
 * When ADK_TEST_MODEL=ollama_chat/<model> is set, this helper registers an
 * OllamaLlm class that speaks plain /api/chat completions against
 * OLLAMA_API_BASE (default http://localhost:11434).
 *
 * The ollama_chat/ prefix is stripped to derive the Ollama model name.
 * Text parts only — functionCall/functionResponse and any other non-text
 * part kind throw instead of mapping to an empty string (flair#1122). The
 * quickstart-parity agent loop only uses PreloadMemoryTool (a processor-
 * level tool that never reaches the model), so plain chat completions are
 * sufficient.
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

/** Keys that are metadata on a text part, not a distinct part kind. */
const TEXT_PART_KEYS = new Set(["text", "thought", "thoughtSignature"]);

/**
 * Pull `part.text`, or throw if the part is a kind this helper does not map.
 *
 * The old empty-string fallback silently dropped functionCall /
 * functionResponse (and any future non-text kind). A test that starts
 * exercising tool use must fail here, not look like a blank turn.
 * Exported for the #1122 unit test.
 */
export function extractText(part: Part): string {
  for (const key of Object.keys(part) as Array<keyof Part>) {
    if (TEXT_PART_KEYS.has(key)) continue;
    if (part[key] != null) {
      throw new Error(
        `OllamaLlm: unmapped LlmRequest part kind "${String(key)}" — ` +
          "this helper only maps text parts",
      );
    }
  }
  return part.text ?? "";
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
  // adk-js appendInstructions writes config.systemInstruction as a
  // plain string (+= concat) — handle that first.
  if (typeof si === "string") return si.trim() || null;
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

/** Hard timeout for Ollama API calls — prevents indefinite hangs.
 * Must exceed cold-load time (observed ~72s on newton).
 * Override via ADK_TEST_OLLAMA_TIMEOUT_MS. */
const OLLAMA_TIMEOUT_MS = (() => {
  const env = process.env["ADK_TEST_OLLAMA_TIMEOUT_MS"];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 120_000;
})();

export class OllamaLlm extends BaseLlm {
  /**
   * Regex matching the ollama_chat/ prefix for LLMRegistry resolution.
   *
   * IMPORTANT: the registry wraps every regex with ^ and $, so this must
   * NOT include its own ^ anchor.  The pattern ollama_chat\/.* becomes
   * ^ollama_chat\/.*$ which correctly matches ollama_chat/<model>.
   */
  static readonly supportedModels: Array<string | RegExp> = [/ollama_chat\/.*/];

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
      keep_alive: "10m",
    });

    // Merge caller's abortSignal with our hard timeout so any wedge
    // is a loud failure, not a silent hang.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(new Error("OllamaLlm timeout")),
      OLLAMA_TIMEOUT_MS,
    );
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutController.signal])
      : timeoutController.signal;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: combinedSignal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      // Re-throw abort/timeout errors loudly — the consumer must see them,
      // not receive a contentless LlmResponse that passes for empty output.
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `OllamaLlm request aborted (timeout=${OLLAMA_TIMEOUT_MS}ms): ${err.message}`,
        );
      }
      throw err;
    }
    clearTimeout(timeoutId);

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

    // Mirror the Gemini non-streaming finish shape: a single yield with
    // content + finishReason, no partial flag.  The generator returns
    // immediately after — adk-js treats generator exhaustion as turn
    // completion for non-streaming calls.
    yield {
      content: {
        role: "model",
        parts: [{ text: replyText }],
      },
      finishReason: "STOP",
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
