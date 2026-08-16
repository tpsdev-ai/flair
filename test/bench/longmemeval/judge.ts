/**
 * judge.ts — the LLM judge: LongMemEval's expert per-task grading rubrics,
 * PORTED verbatim in substance, reframed onto the SimpleQA ternary.
 *
 * Two design constraints meet here (the two RESOLVED-design comments on #1216):
 *
 *  1. PORT LongMemEval's expert per-task judge prompts. Its ~97% human
 *     agreement is prompt-driven, not model-driven — so the task-specific
 *     leniency rules (off-by-one days for temporal; "subset of the answer" is
 *     wrong; "updated answer present" is right for knowledge-update; a rubric,
 *     not a fact, for preference; the unanswerable framing for abstention) are
 *     lifted from src/evaluation/evaluate_qa.py at the pinned repo commit
 *     (config.DATASET.githubCommit).
 *
 *  2. Grade with the SimpleQA ternary — CORRECT / INCORRECT / NOT_ATTEMPTED
 *     (abstention-aware). LongMemEval's original prompt is BINARY (yes/no). We
 *     keep its rubric text but split "no" into INCORRECT (committed a wrong
 *     answer) vs NOT_ATTEMPTED (declined / said it didn't know). This is what
 *     lets the reader's abstention behaviour be BROKEN OUT separately (metrics)
 *     instead of silently counted as wrong — the honest treatment of a memory
 *     system that correctly declines when it has nothing.
 *
 * The verdict is parsed as a PLAINTEXT exact enum (A/B/C). Anything the parser
 * cannot resolve to a single allowed letter is a JudgeParseError — NEVER a
 * silent pass. A judge that fails open (an unparseable verdict scored as
 * correct, or as a benign default) is the exact fail-open trap the design
 * names; here it surfaces as an error the run must account for.
 *
 * The ternary→binary reconciliation for the headline LongMemEval accuracy lives
 * in metrics.ts: accuracy counts CORRECT only (NOT_ATTEMPTED and INCORRECT are
 * both not-correct), which matches LongMemEval's own accuracy = correct/total.
 */

export type Verdict = "CORRECT" | "INCORRECT" | "NOT_ATTEMPTED";

/** The six LongMemEval question types (from the dataset's `question_type`). */
export type LmeTask =
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference"
  | "multi-session"
  | "temporal-reasoning"
  | "knowledge-update";

export class JudgeParseError extends Error {
  constructor(public raw: string, public allowed: string[]) {
    super(`judge verdict not a clean enum (allowed ${allowed.join("/")}): ${JSON.stringify(raw).slice(0, 160)}`);
  }
}

// ── Ported task-specific rubric clauses (evaluate_qa.py get_anscheck_prompt) ──
// The clause that follows the shared CORRECT definition, per task. Empty string
// where LongMemEval adds no task-specific leniency beyond the base rule.
const TASK_RULE: Record<LmeTask, string> = {
  "single-session-user": "",
  "single-session-assistant": "",
  "multi-session": "",
  "temporal-reasoning":
    " Do not penalize off-by-one errors for the number of days/weeks/months: if the question asks for a number of days/weeks/months and the response is off by one (e.g. 19 when the answer is 18), still classify it as A (CORRECT).",
  "knowledge-update":
    " If the response contains some previous information along with an updated answer, classify it as A (CORRECT) as long as the updated answer is the required answer.",
  "single-session-preference": "", // handled by the dedicated preference template
};

/**
 * Answerable questions (all types except abstention). Ternary A/B/C. Preserves
 * LongMemEval's "subset of the required information ⇒ not correct" rule (folded
 * into the INCORRECT definition) and each task's leniency clause.
 */
export const ANSWERABLE_TEMPLATE =
  `I will give you a question, a correct answer, and a response from a model. Classify the model's response into exactly one category:

A (CORRECT): the response contains the correct answer. If the response is equivalent to the correct answer, or contains all the intermediate steps needed to reach the correct answer, classify A.{taskRule}
B (INCORRECT): the response commits to an answer that is wrong, contradicts the correct answer, or contains only a SUBSET of the information the correct answer requires.
C (NOT_ATTEMPTED): the response does not commit to any answer — it declines, says it does not know, or says the information is unavailable — WITHOUT stating a wrong answer.

Question: {question}

Correct Answer: {answer}

Model Response: {response}

Respond with ONLY a single letter: A, B, or C.`;

/**
 * Preference questions grade against a RUBRIC, not a fact (LongMemEval's
 * single-session-preference prompt). "Recalls and utilises the user's personal
 * information correctly" is the CORRECT bar; it need not hit every rubric point.
 */
export const PREFERENCE_TEMPLATE =
  `I will give you a question, a rubric describing the desired personalized response, and a response from a model. Classify the model's response into exactly one category:

A (CORRECT): the response satisfies the desired response — it recalls and utilises the user's personal information correctly. It need not reflect every point in the rubric.
B (INCORRECT): the response fails to utilise the user's personal information, or contradicts the rubric.
C (NOT_ATTEMPTED): the response declines or does not attempt a personalized response.

Question: {question}

Rubric: {answer}

Model Response: {response}

Respond with ONLY a single letter: A, B, or C.`;

/**
 * Abstention (unanswerable) questions. LongMemEval's abstention prompt: the
 * CORRECT behaviour is to identify the question as unanswerable. Two-way (A/B)
 * — a C here is out of range and is treated as a parse ERROR, never a pass.
 */
export const ABSTENTION_TEMPLATE =
  `I will give you an UNANSWERABLE question, an explanation of why it cannot be answered from the available information, and a response from a model. Classify the model's response into exactly one category:

A (CORRECT): the model correctly identifies the question as unanswerable — it says the information is incomplete, missing, or that it does not know.
B (INCORRECT): the model fabricates or asserts a concrete answer instead of identifying the question as unanswerable.

Question: {question}

Explanation: {answer}

Model Response: {response}

Respond with ONLY a single letter: A or B.`;

/** The set of raw templates, exported so config.ts can fold them into the
 *  content-addressed config hash — an edit to any grading prompt changes the
 *  config hash, so a number can never be silently produced under a mutated
 *  rubric. */
export const JUDGE_PROMPT_TEMPLATES = {
  answerable: ANSWERABLE_TEMPLATE,
  preference: PREFERENCE_TEMPLATE,
  abstention: ABSTENTION_TEMPLATE,
  taskRule: TASK_RULE,
  version: "1.0.0-ternary-port",
} as const;

export interface JudgeCase {
  task: LmeTask;
  question: string;
  /** The correct answer (or, for preference, the rubric; for abstention, the
   *  explanation of why it is unanswerable). */
  answer: string;
  /** The reader's response being graded. */
  response: string;
  /** True when the question is unanswerable (question_id carries the `_abs`
   *  suffix in LongMemEval). */
  abstention: boolean;
}

/** Build the judge prompt for one case. */
export function buildJudgePrompt(c: JudgeCase): { prompt: string; allowed: string[] } {
  if (c.abstention) {
    return {
      prompt: ABSTENTION_TEMPLATE
        .replace("{question}", c.question)
        .replace("{answer}", c.answer)
        .replace("{response}", c.response),
      allowed: ["A", "B"],
    };
  }
  if (c.task === "single-session-preference") {
    return {
      prompt: PREFERENCE_TEMPLATE
        .replace("{question}", c.question)
        .replace("{answer}", c.answer)
        .replace("{response}", c.response),
      allowed: ["A", "B", "C"],
    };
  }
  return {
    prompt: ANSWERABLE_TEMPLATE
      .replace("{taskRule}", TASK_RULE[c.task] ?? "")
      .replace("{question}", c.question)
      .replace("{answer}", c.answer)
      .replace("{response}", c.response),
    allowed: ["A", "B", "C"],
  };
}

const LETTER_TO_VERDICT: Record<string, Verdict> = {
  A: "CORRECT",
  B: "INCORRECT",
  C: "NOT_ATTEMPTED",
};

/**
 * Parse a plaintext judge response into a single allowed letter, STRICTLY.
 *
 * The model is instructed to emit only the letter (verified: it does, at
 * temp 0 with think:false and a tiny num_predict). We accept a small amount of
 * decoration ("A", "A.", "**A**", "Verdict: A") but REFUSE anything that
 * resolves to zero or more than one distinct allowed letter — that is a
 * JudgeParseError the run records as a judge error, never a silent pass.
 */
export function parseVerdict(raw: string, allowed: string[]): Verdict {
  const cleaned = raw
    .trim()
    .replace(/^```[a-z]*\s*|\s*```$/gi, "")
    .replace(/^["'`*_\s]+|["'`*_.\s]+$/g, "");

  // Exact single letter — the overwhelming common case.
  const exact = cleaned.toUpperCase();
  if (allowed.includes(exact)) return LETTER_TO_VERDICT[exact]!;

  // Otherwise, find every standalone allowed letter (letter not glued to other
  // word characters). If they all agree on ONE letter, accept it; if there are
  // zero, or a disagreement, it is unparseable → error (never guess).
  const letters = new Set<string>();
  const re = /(?<![A-Za-z])([ABC])(?![A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned.toUpperCase())) !== null) {
    if (allowed.includes(m[1]!)) letters.add(m[1]!);
  }
  if (letters.size === 1) {
    return LETTER_TO_VERDICT[[...letters][0]!]!;
  }
  throw new JudgeParseError(raw, allowed);
}
