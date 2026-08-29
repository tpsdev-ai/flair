/**
 * ollama.ts — the ONE deterministic Ollama call path for the Layer 2 harness.
 *
 * Under the `local` profile both the reader and the judge run on Newton via
 * Ollama; under `cloud` the same call path talks to ollama.com. Either way the
 * client is deliberately narrow, because every knob below is one that would
 * otherwise put sampling noise inside the measurement:
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
 *     the exact CONFIGURATION" means the exact weights, not whatever the tag
 *     points at today. Note the scope: this pins what was run. It does not make
 *     the OUTPUT re-derivable — the cloud reader is not bitwise-stable at
 *     temperature 0 / seed 0, which is what determinism.ts measures and
 *     publishes.
 *
 * Pure transport + a pin check. No dataset, no prompts, no scoring.
 */

// ── Cloud auth (ported from tps-bench, adopted 2026-08-20) ──────────────────
// OPERATIONAL-ONLY: transport credentials, deliberately NOT in the hashed
// config. Which endpoint served a pinned digest cannot change what is
// measured — assertModelPinned() already fails loud unless the digest matches,
// so authenticating to ollama.com and authenticating to Newton either serve
// the SAME pinned weights or the run aborts.
//
// The key is referenced BY PATH and read IN-PROCESS: it never appears in argv
// (so never in shell history, `ps`, or a transcript), never in the artifact,
// and never in a log line. Unset => no header at all, i.e. byte-identical
// behavior to a local/Newton run.
import { readFileSync } from "node:fs";
const _KEY_FILE = process.env.LME_OLLAMA_KEY_FILE;
const AUTH_HEADERS: Record<string, string> = _KEY_FILE
  ? { Authorization: "Bearer " + readFileSync(_KEY_FILE, "utf8").trim() }
  : {};

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
  // ── Cloud-cap resilience (ported from tps-bench, headline run 2026-08-21) ─
  // OPERATIONAL-ONLY: HTTP 429 backs off 60s → 300s → 300s before failing; a
  // 5xx gets ONE 30s retry. Not in the hashed config, and the reasoning is
  // checkable rather than a matter of taste: the request body is byte-for-byte
  // identical on every attempt and the model is pinned with temperature 0 /
  // seed 0 / fixed num_ctx+num_predict, so a retry can only turn "no answer"
  // into "the same answer this call was always going to produce". It cannot
  // select among answers — there is no resampling and no prompt mutation.
  //
  // Deliberately NARROW: only 429, 5xx, and transport-level failures retry, and
  // only for a bounded number of rounds. Any other status still fails loud.
  // Retrying a 4xx (a malformed prompt, a wrong model name) would be masking a
  // broken call, and retrying until success would let a flaky endpoint quietly
  // shape the sample.
  //
  // Transport failures (timeout, connection reset, DNS, socket hangup) are a
  // distinct category: fetch() rejects BEFORE any response is received, so
  // there is no answer to mask and nothing to bias. The same determinism
  // argument that justifies the 5xx retry applies — a retry can only turn "no
  // answer" into "the same answer this call was always going to produce". The
  // retry is scoped to the fetch() rejection ONLY: a failure after a response
  // was received (res.text()/JSON parse) is NOT retried, because that would be
  // retrying something that already had an effect.
  const RATE_WAITS = [60_000, 300_000, 300_000];
  const TRANSPORT_RETRIES = 2; // bounded: two retries after the initial attempt
  const TRANSPORT_WAIT_MS = 30_000;
  let rateAttempt = 0;
  let serverRetried = false;
  let transportAttempt = 0;
  let t0: number, res: Response, latencyMs: number, text: string;
  for (;;) {
    t0 = performance.now();
    try {
      res = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (transportAttempt < TRANSPORT_RETRIES) {
        transportAttempt++;
        console.error(`[ollama] transport failure to ${host} — retry ${transportAttempt}/${TRANSPORT_RETRIES} in ${TRANSPORT_WAIT_MS / 1000}s (${err instanceof Error ? err.message : String(err)})`);
        await new Promise((r) => setTimeout(r, TRANSPORT_WAIT_MS));
        continue;
      }
      throw new OllamaError(`generate(${spec.model}) transport failure to ${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
    latencyMs = performance.now() - t0;
    text = await res.text();
    if (res.status === 429 && rateAttempt < RATE_WAITS.length) {
      const wait = RATE_WAITS[rateAttempt++]!;
      console.error(`[ollama] 429 from ${host} — backing off ${wait / 1000}s (round ${rateAttempt}/${RATE_WAITS.length})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status >= 500 && !serverRetried) {
      serverRetried = true;
      console.error(`[ollama] HTTP ${res.status} from ${host} — one retry in 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    break;
  }
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
 * the digest pinned in config.ts. Tags are mutable; a silent re-tag would let a
 * run that reports the pinned `configHash` have been served by different
 * weights — the anchor would name a configuration that was not the one that
 * ran. Fail loud, never warn-and-go
 * (a shipped default that resolves to whatever-is-there is a trust anchor —
 * MEMORY.md).
 */
export async function assertModelPinned(host: string, spec: OllamaModelSpec): Promise<{ actualDigest: string }> {
  let res: Response;
  try {
    res = await fetch(`${host}/api/tags`, { headers: AUTH_HEADERS, signal: AbortSignal.timeout(10_000) });
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
  const res = await fetch(`${host}/api/tags`, { headers: AUTH_HEADERS, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new OllamaError(`pingOllama: HTTP ${res.status} from ${host}`);
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => m.name);
}
