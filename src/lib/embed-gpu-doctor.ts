/**
 * embed-gpu-doctor.ts — the flair doctor line for an unconfirmed Metal offload
 * (flair#1437 PLAN ACCEPTED condition 1; severity split added by flair#1761).
 *
 * /Health already carries `embedding.fallback` when offload was requested
 * and the GPU log heuristic did not confirm Metal. Operators read
 * `flair doctor`, not Health. This is the single decision: given the public
 * Health embedding field, what (if anything) doctor prints, and whether it
 * weighs on doctor's exit code.
 *
 * flair#1761: the finding is NOT one severity. The fallback sentence is a log
 * heuristic, not an observation (it can err in both directions), and since
 * 0.55.0 the derived Metal default requests offload on every darwin-arm64
 * host without the operator asking. So the severity is read off `source`:
 *
 *   source === "detected"  → the default chose for the operator; advisory
 *                            WARNING, does not count as an issue.
 *   source === "env"       → the operator explicitly set
 *                            FLAIR_EMBED_GPU_LAYERS; blocking ERROR.
 *   missing / unrecognized → FAIL CLOSED: blocking ERROR, exactly as before.
 *                            An unknown state is never softened to advisory.
 */
export const EMBED_GPU_DOCTOR_MARKER = "requested GPU offload; Metal did not engage";

/** Advisory wording (flair#1761). We cannot observe engagement, only that it
 *  was NOT confirmed — the old "did not engage" over-claimed. */
export const EMBED_GPU_DETECTED_MESSAGE =
  "Automatic Metal acceleration was requested, but engagement could not be verified.";

export interface EmbedGpuDoctorFinding {
  /** true → contributes to doctor's issue count / non-zero exit. */
  isIssue: boolean;
  /** Severity the caller renders. "warn" is advisory, "error" is blocking. */
  icon: "error" | "warn";
  message: string;
  fixHint: string;
}

/**
 * Doctor finding, or null when there is nothing to say.
 * Only the Health `fallback` sentence is a finding — a stated CPU default
 * or a confirmed Metal run is not an issue. The severity depends on
 * `source` (flair#1761): an operator-requested offload that was not
 * confirmed still fails loud, but the derived Metal default is advisory and
 * an unrecognized source fails closed.
 */
export function describeEmbedGpuDoctorFinding(
  embedding: unknown,
): EmbedGpuDoctorFinding | null {
  if (embedding == null || typeof embedding !== "object" || Array.isArray(embedding)) {
    return null;
  }
  const fallback = (embedding as { fallback?: unknown }).fallback;
  if (typeof fallback !== "string" || !fallback.includes(EMBED_GPU_DOCTOR_MARKER)) {
    return null;
  }
  const source = (embedding as { source?: unknown }).source;

  if (source === "detected") {
    // The Metal default requested offload for the operator; nothing was
    // chosen. Working embeddings on CPU is a standing, benign condition —
    // keep it visible as a persistent warning, never a blocking finding.
    return {
      isIssue: false,
      icon: "warn",
      message: EMBED_GPU_DETECTED_MESSAGE,
      fixHint: "Pin CPU with FLAIR_EMBED_GPU_LAYERS=0.",
    };
  }

  // A source the operator set ("env"), or one we do not recognize at all
  // (missing/unknown) — fail closed and keep the existing fail-loud finding.
  return {
    isIssue: true,
    icon: "error",
    message: fallback,
    fixHint:
      "Pin CPU with FLAIR_EMBED_GPU_LAYERS=0, or restore @node-llama-cpp/mac-arm64-metal and flair restart.",
  };
}
