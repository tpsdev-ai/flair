/**
 * embedding-space-doctor.ts — the flair doctor finding for the query-time
 * embedding-space guard's verdict (flair#2530).
 *
 * resources/embedding-space-guard.ts runs inside the Harper worker and reports
 * its verdict on the public /Health body as `embeddingSpace: { state, reason }`.
 * The guard fails closed: only `state: "uniform"` serves the embedding leg; a
 * `mixed` state, an `unverified` verdict (before the first scan completes) and a
 * `scan-failed` verdict (the last published scan threw, no foreign stamp known)
 * all make the recall leg refuse a query embedding. This module is the single
 * decision: given that field, what doctor prints and whether it weighs on the
 * exit code.
 *
 * Only `mixed` is a blocking finding: a non-current model stamp was observed,
 * possibly stale until a successful rescan, which warrants investigation
 * (`flair reembed --stale-only` reconciles a real one). `unverified` and
 * `scan-failed` are advisories, and `uniform` is an OK line. A rescan starts
 * only on a later guard consult (a recall with a query embedding outside
 * bm25-only mode, or a write-time dedup check; /Health does not consult): at
 * once while no verdict is known, otherwise once RECHECK_MS has passed since
 * the last published verdict. The state becomes `uniform` only when such a scan
 * succeeds and finds the stamps uniform; with no consults, nothing retries.
 * `uniform` means stamp-metadata uniformity: a stored vector without a
 * space-bearing `embeddingModel` stamp is not checked (flair#2573). An absent or
 * unrecognized field prints nothing: an older or foreign server's verdict is
 * not one to claim.
 */
export type EmbeddingSpaceGuardState = "uniform" | "mixed" | "unverified" | "scan-failed";

export interface EmbeddingSpaceDoctorFinding {
  /** true → contributes to doctor's issue count / non-zero exit. */
  isIssue: boolean;
  /** Severity the caller renders. "warn" is advisory, "error" is blocking. */
  icon: "ok" | "warn" | "error";
  message: string;
  fixHint?: string;
}

/**
 * A bounded, printable reason for a failed scan. The guard's own
 * reason strings are short and content-free, but /Health is unauthenticated, so
 * bound the length and reject control characters before printing the string.
 */
export function boundedScanFailureReason(reason: unknown): string {
  if (typeof reason !== "string") return "unspecified";
  const s = reason.trim();
  if (s.length === 0 || s.length > 120 || /[\u0000-\u001f\u007f]/.test(s)) return "unspecified";
  return s;
}

/**
 * Doctor finding, or null when there is nothing to say. The four states map to
 * a distinct line: `uniform` an OK line; `mixed` a blocking finding with the
 * reembed remedy; `unverified` and `scan-failed` advisories naming the state.
 */
export function describeEmbeddingSpaceDoctorFinding(field: unknown): EmbeddingSpaceDoctorFinding | null {
  if (field == null || typeof field !== "object" || Array.isArray(field)) return null;
  const rec = field as { state?: unknown; reason?: unknown };
  switch (rec.state) {
    case "uniform":
      // Stamp metadata only; an unstamped stored vector is not checked (flair#2573).
      return { isIssue: false, icon: "ok", message: "embedding model stamps verified uniform" };
    case "mixed":
      return {
        isIssue: true,
        icon: "error",
        message:
          "a non-current embedding model stamp was observed — the embedding leg is refused" +
          // A known foreign stamp outranks a scan error; name the error too.
          (rec.reason == null ? "" : `; last scan failed (${boundedScanFailureReason(rec.reason)})`),
        fixHint: "Reconcile to one space with: flair reembed --stale-only",
      };
    case "unverified":
      return {
        isIssue: false,
        icon: "warn",
        message: "embedding space not yet verified — the embedding leg is refused until a scan verifies the stamps",
      };
    case "scan-failed":
      return {
        isIssue: false,
        icon: "warn",
        message:
          `embedding space unverified: last scan failed (${boundedScanFailureReason(rec.reason)}) — ` +
          `the embedding leg is refused`,
      };
    default:
      return null;
  }
}
