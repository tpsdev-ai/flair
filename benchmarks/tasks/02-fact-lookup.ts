import type { Task } from "../harness/types.js";

/**
 * Fact lookup vs hallucination — user states a specific factual claim in
 * session 1, asks the agent to retrieve it in session 2. Baseline must
 * either say "I don't know" or fabricate. Flair should recall verbatim.
 *
 * The mustNotInclude list explicitly forbids deferral phrases, so a baseline
 * agent that refuses to answer doesn't squeak by — the only way to pass is
 * to actually recall.
 */
export const task: Task = {
  id: "02-fact-lookup",
  title: "Fact lookup vs hallucination",
  capability: "Cross-session factual recall — exact value, not paraphrase",
  rationale:
    "Stating a fact once and expecting an agent to recall it later is the most basic memory contract. Without it, agents either fabricate (worse) or constantly re-ask (annoying). With memory, an agent can quote the exact value.",

  turns: [
    {
      prompt:
        "Quick context: our staging deploy webhook is at https://hooks.dtrt.dev/deploy/x9k2-staging-7f3a. I'll need you to remember this for later.",
      expect: {
        rubric:
          "Agent acknowledges the URL. Bonus if the Flair variant explicitly stores it via memory_store. Any acknowledgement is acceptable for the baseline.",
        mustInclude: [],
      },
    },
    {
      kind: "session-boundary",
      describedAs: "Two days later, fresh session.",
    },
    {
      prompt:
        "What's our staging deploy webhook URL? Give me just the URL.",
      expect: {
        rubric:
          "Agent reproduces the EXACT URL (https://hooks.dtrt.dev/deploy/x9k2-staging-7f3a). Partial match (correct domain, wrong path) is a fail because that URL won't actually trigger a deploy. Refusing to answer is also a fail; the task is to test recall, not to test prudence. Fabricating a plausible-looking URL with different segments is a hallucination — flag it.",
        mustInclude: ["x9k2-staging-7f3a"],
        mustNotInclude: ["I don't have", "I don't recall", "no record"],
      },
    },
  ],
};
