/**
 * embed-gpu-doctor.ts — the flair doctor line for a failed Metal offload
 * (flair#1437 PLAN ACCEPTED condition 1).
 *
 * /Health already carries `embedding.fallback` when offload was requested
 * and Metal did not engage. Operators read `flair doctor`, not Health.
 * This is the single decision: given the public Health embedding field,
 * what (if anything) doctor prints. Harper-free; unit-tested.
 */
export const EMBED_GPU_DOCTOR_MARKER = "requested GPU offload; Metal did not engage";

export interface EmbedGpuDoctorFinding {
  isIssue: true;
  icon: "error";
  message: string;
  fixHint: string;
}

/**
 * Fail-loud doctor finding, or null when there is nothing to say.
 * Only the Health `fallback` sentence is a finding — a stated CPU default
 * or a confirmed Metal run is not an issue.
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
  return {
    isIssue: true,
    icon: "error",
    message: fallback,
    fixHint:
      "Pin CPU with FLAIR_EMBED_GPU_LAYERS=0, or restore @node-llama-cpp/mac-arm64-metal and flair restart.",
  };
}
