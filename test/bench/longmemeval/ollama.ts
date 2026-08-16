/**
 * ollama.ts — the ONE deterministic Ollama call path for the Layer 2 harness.
 *
 * Both the reader and the judge run LOCAL on Newton via Ollama. Reproducibility
 * is the edge (#1216 design), so this client is deliberately narrow:
 *
 *   - temperature 0 + a fixed seed + a fixed num_ctx — the run-to-run mean±std
 *     must reflect the memory layer, not sampling noise. A temp≠0 judge would
 *     make the ≥5-run spread sampling noise and collapse the reproducibility
 *     claim (Sherlock #3).
 *   - PLAINTEXT only. We NEVER use Ollama's JSON / structured-output mode: it is
 *     non-deterministic even at a fixed seed (Ollama #12559), and the judge
 *     decision explicitly forbids it. The judge parses a plaintext exact-enum
 *     verdict instead (judge.ts).
 *   - think:false — the reader/judge models carry a "thinking" capability;
 *     thinking tokens are non-deterministic and pollute a short verdict/answer,
 *     so we disable them. (Verified empirically: gemma4/qwen3.6 honor it and
 *     return clean output.)
 *   - DIGEST-pinned. Ollama tags are MUTABLE; sha256 manifest digests are not.
 *     assertModelPinned() refuses to run if the model currently resolving on
 *     the host does not match the digest recorded in config.ts — so "I re-ran
 *     the exact number" means the exact weights, not whatever the tag points at
 *     today.
 *
 * Pure transport + a pin check. No dataset, no prompts, no scoring.
 */

export interface OllamaModelSpec {
  model: string;
  /** The immutable manifest digest recorded at pin time (config.ts). */
  manifestDigest: string;
  temperature: number;
  seed: number;
  numCtx: number;
  numPredict: number;
}

export interface GenerateResult {
  /** The model's raw text response (thinking disabled, plaintext). */
  response: string;
  /** Real prompt token count from the model (tokens FED to the reader/judge). */
  promptTokens: number;
  /** Real generated token count. */
  evalTokens: number;
  /** Wall-clock round trip for this call (ms). */
  latencyMs: number;
  doneReason: string;
}

export class OllamaError extends Error {}

/**
 * A single deterministic generation. `numCtxOverride` lets the full-context arm
 * use its own (still fixed, still pinned) larger window without changing the
 * spec's default num_ctx for every other call — see config.ts FULL_CONTEXT.
 */
export async function generate(
  host: string,
  spec: OllamaModelSpec,
  prompt: string,
  opts: { numCtxOverride?: number; numPredictOverride?: number } = {},
): Promise<GenerateResult> {
  const body = {
    model: spec.model,
    prompt,
    stream: false,
    think: false, // deterministic, no thinking tokens
    // NOTE: no `format` field — plaintext only. JSON/structured mode is
    // non-deterministic at fixed seed (Ollama #12559) and forbidden by design.
    options: {
      temperature: spec.temperature,
      seed: spec.seed,
      num_ctx: opts.numCtxOverride ?? spec.numCtx,
      num_predict: opts.numPredictOverride ?? spec.numPredict,
    },
  };
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new OllamaError(`generate(${spec.model}) transport failure to ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const latencyMs = performance.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    throw new OllamaError(`generate(${spec.model}) HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let j: any;
  try { j = JSON.parse(text); } catch {
    throw new OllamaError(`generate(${spec.model}) non-JSON envelope: ${text.slice(0, 200)}`);
  }
  if (typeof j.response !== "string") {
    throw new OllamaError(`generate(${spec.model}) missing response field: ${text.slice(0, 200)}`);
  }
  return {
    response: j.response,
    promptTokens: j.prompt_eval_count ?? 0,
    evalTokens: j.eval_count ?? 0,
    latencyMs,
    doneReason: j.done_reason ?? "",
  };
}

/**
 * Refuse to run unless the model's CURRENT manifest digest on the host matches
 * the digest pinned in config.ts. Tags are mutable; a silent re-tag would make
 * "re-run the number" reproduce a different model. Fail loud, never warn-and-go
 * (a shipped default that resolves to whatever-is-there is a trust anchor —
 * MEMORY.md).
 */
export async function assertModelPinned(host: string, spec: OllamaModelSpec): Promise<{ actualDigest: string }> {
  let res: Response;
  try {
    res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new OllamaError(`assertModelPinned: cannot reach Ollama at ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new OllamaError(`assertModelPinned: /api/tags HTTP ${res.status}`);
  const j: any = await res.json();
  const found = (j.models ?? []).find((m: any) => m.name === spec.model);
  if (!found) {
    throw new OllamaError(
      `assertModelPinned: model "${spec.model}" is not present on ${host}. ` +
      `Pull it first: ollama pull ${spec.model} (expected digest ${spec.manifestDigest}).`,
    );
  }
  const actualDigest = found.digest?.startsWith("sha256:") ? found.digest : `sha256:${found.digest}`;
  if (actualDigest !== spec.manifestDigest) {
    throw new OllamaError(
      `assertModelPinned: DIGEST MISMATCH for "${spec.model}". ` +
      `pinned=${spec.manifestDigest} actual=${actualDigest}. ` +
      `The tag moved — pin the new digest deliberately or pull the pinned one; never run against an unpinned model.`,
    );
  }
  return { actualDigest };
}

/** Confirm the host answers at all (a decisive early failure vs a slow timeout
 *  mid-run). Returns the raw /api/tags model names. */
export async function pingOllama(host: string): Promise<string[]> {
  const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new OllamaError(`pingOllama: HTTP ${res.status} from ${host}`);
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => m.name);
}
