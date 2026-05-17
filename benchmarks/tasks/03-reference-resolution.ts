import type { Task } from "../harness/types.js";

/**
 * Reference resolution — natural multi-session shorthand. User reports
 * a bug in session 1 ("the search latency thing"), comes back in session
 * 2 saying "fix the bug we found yesterday." Baseline has no anchor for
 * "the bug" and has to ask. Flair should resolve the reference from memory.
 *
 * This test fails baseline EITHER by asking "which bug?" (rated as a
 * deferral fail) OR by fabricating "the bug" details (hallucination flag).
 */
export const task: Task = {
  id: "03-reference-resolution",
  title: "Reference resolution from prior session",
  capability: "Resolving anaphoric / definite references using stored context",
  rationale:
    "Real engineering work is full of phrases like 'the bug we found yesterday' or 'the customer who emailed last week'. Without memory, an agent has to play 20 questions every time. With memory, the reference resolves naturally — and the agent looks like a colleague who's been paying attention.",

  turns: [
    {
      prompt:
        "Quick triage note: we noticed the SearchMemories endpoint takes 1.8 seconds on cold cache. The likely cause is that we're rebuilding the HNSW index on every query instead of caching the loaded handle across calls. Don't fix it yet — just acknowledge so we can come back to it.",
      expect: {
        rubric:
          "Agent acknowledges the bug, ideally restating the cause (HNSW handle not cached). Flair variant should explicitly call memory_store with this content.",
        mustInclude: [],
      },
    },
    {
      kind: "session-boundary",
      describedAs: "Next morning, fresh session.",
    },
    {
      prompt:
        "Let's fix the search latency thing we found yesterday. Where should I look first in the code?",
      expect: {
        rubric:
          "Agent must demonstrate it knows which 'thing' is being referenced — the SearchMemories endpoint with the uncached HNSW handle. Asking 'which search latency issue?' is a baseline-variant fail. Pointing at the wrong file/concept (e.g., suggesting the cause is the embedding model when the prior session named HNSW caching) is a hallucination.",
        mustInclude: ["HNSW", "SearchMemories"],
        mustNotInclude: ["which", "could you clarify", "I don't recall", "not aware"],
      },
    },
  ],
};
