import type { Task } from "../harness/types.js";

/**
 * Decision recall — agent makes a technology choice in session 1 with a
 * specific rationale; session 2 asks the agent to explain that choice.
 *
 * Baseline variant has no persistent state — session 2 has no idea a
 * decision was even made. Flair variant should have stored the decision +
 * rationale during session 1 and recall it cleanly in session 2.
 *
 * This is the cleanest possible test of memory: a single fact stated once,
 * recalled across a session boundary. If memory doesn't help here, it
 * doesn't help anywhere.
 */
export const task: Task = {
  id: "01-decision-recall",
  title: "Decision recall across sessions",
  capability: "Cross-session persistence of stated decisions + rationale",
  rationale:
    "Multi-session work depends on agents remembering what was decided and why. Without memory, every session re-litigates settled choices or — worse — silently reverses them.",

  turns: [
    {
      prompt:
        "We need to pick a database for the user-events service. The options are Postgres, MySQL, and ScyllaDB. Here are the constraints: " +
        "(a) the team has 5 years of Postgres operational experience, (b) MySQL has a slightly cheaper managed offering on our cloud, (c) ScyllaDB has the best raw write throughput but no one on the team has run it before. " +
        "Pick one and tell me why.",
      expect: {
        rubric:
          "Agent picks one database and gives a clear rationale tied to the constraints provided. Any of the three could be a defensible choice; the test is that a coherent decision is made and articulated.",
        mustInclude: ["Postgres"], // For determinism in this task, we expect the operational-experience argument to win
      },
    },
    {
      kind: "session-boundary",
      describedAs: "One week later, fresh session.",
    },
    {
      prompt:
        "What did we pick for the user-events service database, and why? Just the headline + the reason. One sentence.",
      expect: {
        rubric:
          "Agent recalls the prior decision (Postgres) AND the operational-experience rationale. If the agent says 'I don't recall' or asks for context, that's a baseline-variant fail. If the agent confidently states a DIFFERENT choice or fabricates a different rationale, that's a hallucination.",
        mustInclude: ["Postgres"],
        mustNotInclude: ["I don't", "I don't know", "I don't have", "no record", "not aware"],
      },
    },
  ],
};
