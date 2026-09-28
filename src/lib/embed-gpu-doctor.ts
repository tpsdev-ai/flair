/**
 * embed-gpu-doctor.ts — the flair doctor line for a Metal offload that is
 * either engine-reported CPU or unconfirmed (flair#1437; severity split
 * flair#1761; readback flair#2031).
 *
 * /Health carries `embedding.fallback` only when the engine itself reports
 * CPU after a GPU request, and `embedding.backend === "unconfirmed"` when
 * the engine exposed no GPU type or layer count. Operators read `flair
 * doctor`, not Health. This is the single decision: given the public Health
 * embedding field, what (if anything) doctor prints, and whether it weighs
 * on doctor's exit code.
 *
 * flair#1761: the finding is NOT one severity. Since 0.55.0 the derived Metal
 * default requests offload on every darwin-arm64 host without the operator
 * asking. Severity is read off `source`:
 *
 *   source === "detected"  → the default chose for the operator; advisory
 *                            WARNING, does not count as an issue.
 *   source === "env"       → the operator explicitly set
 *                            FLAIR_EMBED_GPU_LAYERS; blocking ERROR.
 *   missing / unrecognized → FAIL CLOSED: blocking ERROR, exactly as before.
 *                            An unknown state is never softened to advisory.
 *
 * Unconfirmed is not worded as "did not engage; running CPU".
 */
export const EMBED_GPU_DOCTOR_MARKER = "requested GPU offload; Metal did not engage";

/** Advisory wording (flair#1761). A derived default stays a warning. */
export const EMBED_GPU_DETECTED_MESSAGE =
  "Automatic Metal acceleration was requested, but engagement could not be verified.";

/**
 * Blocking wording when the operator asked for offload and the engine
 * exposed no readback (flair#2031). Does not claim the run is on CPU.
 */
export const EMBED_GPU_UNCONFIRMED_DOCTOR_MESSAGE =
  "GPU offload was requested, but the embedding engine did not report whether Metal engaged.";

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
 * A stated CPU default or a confirmed Metal run is not an issue. A finding
 * is the engine-reported CPU fallback, or `backend: "unconfirmed"`. The
 * severity depends on `source` (flair#1761): the derived Metal default is
 * advisory and an unrecognized source fails closed.
 */
export function describeEmbedGpuDoctorFinding(
  embedding: unknown,
): EmbedGpuDoctorFinding | null {
  if (embedding == null || typeof embedding !== "object" || Array.isArray(embedding)) {
    return null;
  }
  const record = embedding as { fallback?: unknown; source?: unknown; backend?: unknown };
  const fallback = record.fallback;
  const cpuFallback =
    typeof fallback === "string" && fallback.includes(EMBED_GPU_DOCTOR_MARKER);
  const unconfirmed = record.backend === "unconfirmed";
  if (!cpuFallback && !unconfirmed) return null;
  const source = record.source;

  if (source === "detected") {
    // The Metal default requested offload for the operator; nothing was
    // chosen. Keep it visible as a persistent warning, never a blocking
    // finding, and do not claim the process is on CPU when readback is
    // missing.
    return {
      isIssue: false,
      icon: "warn",
      message: EMBED_GPU_DETECTED_MESSAGE,
      fixHint: "Pin CPU with FLAIR_EMBED_GPU_LAYERS=0.",
    };
  }

  // A source the operator set ("env"), or one we do not recognize at all
  // (missing/unknown) — fail closed. Unconfirmed does not reuse the CPU
  // sentence.
  return {
    isIssue: true,
    icon: "error",
    message: unconfirmed && !cpuFallback
      ? EMBED_GPU_UNCONFIRMED_DOCTOR_MESSAGE
      : (fallback as string),
    fixHint: unconfirmed && !cpuFallback
      ? "Pin CPU with FLAIR_EMBED_GPU_LAYERS=0, or restart Flair so the embedding engine can report its backend."
      : "Pin CPU with FLAIR_EMBED_GPU_LAYERS=0, or restore @node-llama-cpp/mac-arm64-metal and flair restart.",
  };
}
