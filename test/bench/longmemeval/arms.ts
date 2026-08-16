/**
 * arms.ts — the four benchmark arms and the reader prompt.
 *
 * The ONLY thing that varies across arms is the CONTEXT fed to the reader
 * (Kern §5a: pin the reader across all arms; only the context changes):
 *
 *   - flair        BM25+RRF hybrid retrieval at documented defaults (the headline).
 *   - vector-only  the same retrieval with BM25 disabled — pure HNSW/vector
 *                  (a clean ablation: Flair with hybrid off, everything else
 *                  identical). Set at the Harper PROCESS level via
 *                  FLAIR_HYBRID_RETRIEVAL=false (eval.ts spawns a second Harper).
 *   - full-context the ENTIRE haystack (the ceiling AND the memory-validity
 *                  check: if it ≈ flair, the benchmark is measuring long-context,
 *                  not memory). Uses its own larger, still-pinned num_ctx.
 *   - no-context   the reader gets ONLY the question — zero memories. The
 *                  decisive contamination probe (Sherlock #2): if this scores
 *                  high, the number reflects the reader's prior knowledge, not
 *                  the memory layer, and the whole result is suspect.
 *
 * The question_date is given to the reader in EVERY arm (it is the clock, not
 * memory), so temporal questions have a reference "today" and the arms differ
 * only in memory content — including no-context, whose memory content is empty.
 */
import type { RetrievedItem } from "../../../packages/flair-bench/lib/index";
import type { LmeSession } from "./dataset";

export type Arm = "flair" | "vector-only" | "full-context" | "no-context";
export const ALL_ARMS: Arm[] = ["flair", "vector-only", "full-context", "no-context"];

/** Arms that retrieve from a running Flair (need an ephemeral Harper). */
export const HARPER_ARMS: Arm[] = ["flair", "vector-only"];

export const READER_SYSTEM =
  "You are a helpful assistant answering the user's question using ONLY the conversation memory provided. " +
  "Answer concisely and directly. If the provided memory does not contain enough information to answer, " +
  "reply that you do not know rather than guessing.";

/** Format retrieved memories (flair / vector-only) as a compact context block.
 *  Items arrive rank-ordered (rank 0 = best). */
export function formatRetrieved(items: RetrievedItem[]): string {
  if (items.length === 0) return "(no relevant memory found)";
  return items.map((it, i) => `- ${(it.content ?? "").trim()}`).join("\n");
}

/** Format the full haystack (full-context arm), in chronological session order
 *  with dates, truncated to a character budget derived from the arm's num_ctx.
 *  Truncation is reported by the caller (a truncated ceiling is a documented
 *  limitation, not a silent one — Kern 3a). */
export function formatFullContext(sessions: LmeSession[], charBudget: number): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const s of sessions) {
    const header = `\n[Session ${s.sessionId} — ${s.date}]\n`;
    if (used + header.length > charBudget) { truncated = true; break; }
    parts.push(header); used += header.length;
    for (const ev of s.events) {
      const line = `${ev.role ?? "?"}: ${ev.content}\n`;
      if (used + line.length > charBudget) { truncated = true; break; }
      parts.push(line); used += line.length;
    }
    if (truncated) break;
  }
  return { text: parts.join(""), truncated };
}

/** Assemble the final reader prompt for one (question, arm). */
export function buildReaderPrompt(question: string, questionDate: string, context: string): string {
  return (
    `${READER_SYSTEM}\n\n` +
    `Current date: ${questionDate}\n\n` +
    `Conversation memory:\n${context || "(none)"}\n\n` +
    `Question: ${question}\n` +
    `Answer:`
  );
}

export const READER_PROMPT_VERSION = "1.0.0";
