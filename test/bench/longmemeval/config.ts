/**
 * config.ts — the PINNED, content-addressed configuration for the LongMemEval_s
 * Layer 2 benchmark. Everything that could move the number is pinned HERE, and
 * `configManifest()` folds all of it (including the exact judge/reader prompt
 * template strings) into one object that `hashConfig()` content-addresses.
 *
 * This is the eval equivalent of pre-registration (Kern §4a, Sherlock #4): the
 * config is written and hashed BEFORE a run, and every run's output references
 * that hash — so a reviewer can verify the reported number came from THIS
 * config, and config-shopping (run 10, publish the best) leaves a trace.
 *
 * Reproducibility is the edge (#1216): anyone re-runs the exact number locally
 * with `ollama pull` at the pinned digests + this dataset commit — no OpenAI
 * key, no spend. Pin by DIGEST, never by tag (tags are mutable).
 */
import { createHash } from "node:crypto";
import { JUDGE_PROMPT_TEMPLATES } from "./judge";
import { READER_SYSTEM, READER_PROMPT_VERSION, READER_PAYLOAD_FORMAT, ALL_ARMS } from "./arms";
import { EXTRACTION_METHOD } from "./extraction";

// ── Dataset: LongMemEval_s, pinned to an immutable HF commit + file sha256 ────
export const DATASET = {
  name: "LongMemEval_s",
  hfRepo: "xiaowu0162/longmemeval",
  hfRevision: "2ec2a557f339b6c0369619b1ed5793734cc87533",
  file: "longmemeval_s",
  sha256: "08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894",
  // The GitHub repo commit the judge prompts were ported from.
  githubRepo: "xiaowu0162/LongMemEval",
  githubCommit: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
  totalQuestions: 500,
} as const;

// ── Judge: gemma4:31b-it-q8_0, LOCAL on Newton via Ollama ────────────────────
// Pinned by manifest digest (immutable); the GGUF weights blob sha256 is
// recorded too, as an even-more-verifiable content hash of the weights.
export const JUDGE = {
  model: "gemma4:31b-it-q8_0",
  manifestDigest: "sha256:53dd8459790f8795177444daa9e33f417e03c0d1cdedb80b6c73898603d20aef",
  weightsSha256: "sha256:a0feadb736f521df6de4b1bd3cbf06c00f9fd04570ddc1e47b8ec9ecbbd6b51d",
  family: "gemma4",
  temperature: 0,
  seed: 0,
  numCtx: 8192,
  numPredict: 16,
} as const;

// ── Reader: qwen3.6:27b-coding-mxfp8 (Qwen family) ───────────────────────────
// A DIFFERENT family than the Gemma judge — the self-preference control
// (judge family != reader family). Pinned by manifest digest.
export const READER = {
  model: "qwen3.6:27b-coding-mxfp8",
  manifestDigest: "sha256:a7185d39ff35a472a2721b87e1bbb90810bcd381d415666ce2137838e66f2780",
  family: "qwen3_5",
  temperature: 0,
  seed: 0,
  numCtx: 16384,       // retrieval arms (flair / vector-only / no-context)
  numPredict: 256,
} as const;

// The full-context arm needs a much larger (still fixed, still pinned) window
// to hold a ~115k-token haystack — its job is to be the ceiling, so it must
// actually receive the history (Kern 3a). Both models support 262144.
//
// The pinned default for the publishable run is 131072. It is overridable via
// LME_FULL_CTX ONLY to make a validation slice tractable (a ~100k-token prefill
// is minutes/call) — and because configManifest() reads FULL_CONTEXT, whatever
// value is used is RECORDED in the config hash and the artifact, so a reduced
// validation window is never silent. char budget ≈ 3 chars/token.
const FULL_CTX_NUMCTX = parseInt(process.env.LME_FULL_CTX ?? "131072", 10);
export const FULL_CONTEXT = {
  numCtx: FULL_CTX_NUMCTX,
  charBudget: FULL_CTX_NUMCTX * 3,
} as const;

// ── Retrieval: documented defaults, held fixed across arms ───────────────────
export const RETRIEVAL = {
  scoring: "raw" as const,       // production default since flair#623
  readerTopK: 20,                // memories fed to the reader (flair / vector-only)
  // hybrid on/off is a Harper PROCESS-level env (FLAIR_HYBRID_RETRIEVAL), set
  // per arm by eval.ts: flair=true, vector-only=false.
} as const;

export const INGESTION = {
  granularity: "per-event" as const, // the LOCKED #1216 decision (one Memory per turn)
} as const;

export const OLLAMA_HOST = process.env.LME_OLLAMA_HOST ?? "http://192.168.2.64:11434";

// Cross-family self-preference control — fail loud if it is ever violated.
// Compared as strings on purpose: the pinned literals differ today, but this is
// a runtime guard against a FUTURE config edit that sets them equal, so the
// comparison must not be narrowed away by the const-literal types.
export function assertCrossFamily(): void {
  if ((JUDGE.family as string) === (READER.family as string)) {
    throw new Error(
      `self-preference control violated: judge family (${JUDGE.family}) === reader family (${READER.family}). ` +
      `The judge must be a different family than the reader.`,
    );
  }
}

/** The full configuration object that gets content-addressed. Includes the
 *  exact prompt template strings so any edit to a grading/reader prompt changes
 *  the hash. */
export function configManifest(slice: { n: number; seed: number; questionIds: string[]; runs: number }) {
  return {
    schema: "longmemeval-s.layer2.config/1",
    dataset: DATASET,
    judge: JUDGE,
    reader: READER,
    fullContext: FULL_CONTEXT,
    retrieval: RETRIEVAL,
    ingestion: INGESTION,
    arms: ALL_ARMS,
    prompts: {
      judge: JUDGE_PROMPT_TEMPLATES,
      readerSystem: READER_SYSTEM,
      readerPromptVersion: READER_PROMPT_VERSION,
      // The retrieved-memory payload format fed to the reader (arms.ts
      // formatRetrieved). Hashed for the same reason the prompt strings are:
      // a payload-format change is a MEASUREMENT VARIANT and must never hash
      // identically to a run on the old format. v2-dated = dates on each line.
      readerPayloadFormat: READER_PAYLOAD_FORMAT,
    },
    extraction: EXTRACTION_METHOD,
    slice: {
      n: slice.n,
      seed: slice.seed,
      runs: slice.runs,
      // The exact questions this config commits to, sorted for a stable hash.
      questionIds: [...slice.questionIds].sort(),
    },
  };
}

/** Canonical JSON: keys sorted recursively, so the hash is stable across
 *  machines and key-insertion order.
 *
 *  PORTABILITY CAVEAT (verified 2026-08-23 while re-deriving a payload-A/B
 *  artifact hash in Python): the canonical form inherits `JSON.stringify`'s
 *  NUMBER formatting, which is ECMAScript's Number::toString — exponential
 *  notation only when the decimal exponent is < -6 or >= 21. Python's `repr`
 *  switches to exponential at 1e-4, so a naive Python re-implementation
 *  serialises 2.98e-6 as "2.980232238769545e-06" where this emits
 *  "0.000002980232238769545", and the recomputed hash MISMATCHES on content
 *  that is byte-identical in meaning.
 *
 *  This bites exactly where it is least welcome: tiny p-values, i.e. a STRONG
 *  result. A reviewer verifying an artifact outside JS must replicate
 *  Number::toString or compare via a JS runtime — a mismatch there is a
 *  formatting artefact, NOT evidence of tampering. Left as-is deliberately:
 *  changing the number format now would invalidate every artifact already
 *  hashed. Document it, do not silently "fix" it. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: any): any {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The content-address of a config manifest. */
export function hashConfig(manifest: unknown): string {
  return sha256hex(canonicalJson(manifest));
}
