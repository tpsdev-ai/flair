import { describe, test, expect, mock, afterEach } from "bun:test";
import { generate, OllamaError } from "../bench/longmemeval/ollama";

/**
 * The bench judge seam retries transport-level failures (timeout, connection
 * reset, DNS, socket hangup) a bounded number of times, on the same determinism
 * argument that already justifies the 5xx retry: fetch() rejects BEFORE any
 * response is received, so there is no answer to mask and nothing to bias.
 *
 * The two checks that matter (flair#1435):
 *   1. a simulated transport timeout retries and the run continues;
 *   2. a simulated 4xx that is NOT 429 still refuses immediately, unchanged.
 * The second is the negative control — a fix that only exercises the happy path
 * proves nothing, because the hazard is widening "refuse unknown errors" into
 * "retry everything".
 */

const origFetch = globalThis.fetch;
const origSetTimeout = globalThis.setTimeout;
const origConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.setTimeout = origSetTimeout;
  console.error = origConsoleError;
});

/** Make the retry backoff resolve immediately so tests don't block on 30s. */
function fastTimers() {
  globalThis.setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}

function okResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function httpResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
}

const spec = {
  model: "gemma4:31b",
  manifestDigest: "sha256:abc",
  temperature: 0,
  seed: 0,
  numCtx: 4096,
  numPredict: 256,
};

describe("generate — transport retry (bounded, scoped to fetch rejection)", () => {
  test("a transport timeout retries and the run continues", async () => {
    fastTimers();
    const errors: string[] = [];
    console.error = ((msg: string) => {
      errors.push(msg);
    }) as typeof console.error;

    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls <= 2) {
        throw new Error("The operation timed out.");
      }
      return okResponse({ response: "A", prompt_eval_count: 10, eval_count: 1, done_reason: "stop" });
    }) as unknown as typeof fetch;

    const result = await generate("https://ollama.com", spec, "prompt");

    expect(result.response).toBe("A");
    expect(calls).toBe(3); // initial attempt + 2 bounded retries
    // The retry must be visible in the log, not silent.
    expect(errors.some((e) => e.includes("retry 1/2"))).toBe(true);
    expect(errors.some((e) => e.includes("retry 2/2"))).toBe(true);
  });

  test("a persistent transport failure fails loud after the bounded rounds", async () => {
    fastTimers();
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    await expect(generate("https://ollama.com", spec, "prompt")).rejects.toThrow(OllamaError);
    expect(calls).toBe(3); // bounded: initial + 2 retries, then fail loud
  });

  test("a 4xx that is NOT 429 still refuses immediately, unchanged", async () => {
    fastTimers();
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return httpResponse(400, "bad request");
    }) as unknown as typeof fetch;

    await expect(generate("https://ollama.com", spec, "prompt")).rejects.toThrow(OllamaError);
    expect(calls).toBe(1); // no retry — the refusal we did not intend to change still fires
  });
});
