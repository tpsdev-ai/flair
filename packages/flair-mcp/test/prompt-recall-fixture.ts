/**
 * prompt-recall-fixture.ts — the fixture memory store the flair-prompt-recall
 * tests replay against (flair#2066). Not a test file itself.
 *
 * It stands in for the server's hybrid search with the two properties the
 * hook's behaviour depends on, and nothing more:
 *
 *   1. Every readable memory comes back with a NONZERO similarity. Real
 *      embeddings never score an unrelated memory at 0 (the shipped model
 *      scored every record in the flair#1246 measurement at ~0.44 or more), so
 *      a hook without a relevance threshold would inject unrelated memories.
 *      Here an unrelated memory scores 0.46–0.54.
 *   2. A memory that shares a DISTINCTIVE term with the query (a term held by
 *      fewer than half of the corpus's memories, as a lexical leg would weigh
 *      it) scores high: 0.80 and up.
 *
 * Read scope follows the server's rule: an agent sees its own memories at any
 * visibility plus other agents' non-private ones. The store records every
 * client it builds (by agent id) and every search call it answers.
 */

import type { RecallHit, RecallSearchClient } from "../src/prompt-recall-hook.ts";

export const AGENT = "agent-a";
export const OTHER_AGENT = "agent-b";

export interface FixtureMemory {
  id: string;
  agentId: string;
  visibility: "private" | "shared";
  createdAt: string;
  content: string;
}

/** The user's two directions on the named term, plus unrelated memories and one
 *  memory the hook's agent may not read. */
export const FIXTURE_MEMORIES: readonly FixtureMemory[] = [
  {
    id: "mem-dir-jev-routing",
    agentId: AGENT,
    visibility: "shared",
    createdAt: "2026-09-26T17:04:00.000Z",
    content:
      "User direction: adopt Jev for model routing. The decision model is local and routes generation; frontier models are called only to adjudicate.",
  },
  {
    id: "mem-dir-jev-slot",
    agentId: AGENT,
    visibility: "shared",
    createdAt: "2026-09-28T09:30:00.000Z",
    content:
      "User direction: under Jev the generator never picks its own model. It asks a decision slot, and the local decision model fills it.",
  },
  {
    id: "mem-release-checklist",
    agentId: AGENT,
    visibility: "shared",
    createdAt: "2026-09-20T12:00:00.000Z",
    content: "Release checklist: cut the release PR from a fresh clone, wait for CI to pass, then push the tag.",
  },
  {
    id: "mem-backup-schedule",
    agentId: AGENT,
    visibility: "private",
    createdAt: "2026-09-18T08:00:00.000Z",
    content: "The staging database is backed up nightly at 02:00 UTC and a restore is rehearsed every month.",
  },
  {
    id: "mem-status-style",
    agentId: AGENT,
    visibility: "shared",
    createdAt: "2026-09-15T16:45:00.000Z",
    content: "Status updates lead with the delta since the last report, then any open question.",
  },
  {
    id: "mem-changelog-rule",
    agentId: OTHER_AGENT,
    visibility: "shared",
    createdAt: "2026-09-10T10:00:00.000Z",
    content: "Team convention: every pull request carries a changelog fragment.",
  },
  {
    id: "mem-other-private-jev",
    agentId: OTHER_AGENT,
    visibility: "private",
    createdAt: "2026-09-27T11:00:00.000Z",
    content: "Private draft notes about Jev pricing, kept from other agents.",
  },
];

/** The replay prompt: it names the term, in words none of the directions use,
 *  wrapped the way a chat bridge delivers a message (markup, ids, a URL). */
export const REPLAY_PROMPT =
  '<channel source="chat" chat_id="990011223344556677" message_id="990011223344556688" user="alex">' +
  "Saw a thread about Jev this morning https://example.com/p/9f8e7d6c5b4a39281706f5e4d3c2b1a0?ref=share " +
  "ever heard of it? Worth a look?</channel>";

/** A prompt about something the store holds nothing on. */
export const UNRELATED_PROMPT = "How do I center a div horizontally with flexbox in CSS?";

/** A background task notification the harness submits as a prompt. It names
 *  the term, so a hook that searched it would inject the directions. */
export const NOTIFICATION_PROMPT =
  "<task-notification>\n<task-id>b7x2k</task-id>\n<status>completed</status>\n" +
  '<summary>Background command "grep -rn Jev notes/" completed (exit code 0)</summary>\n</task-notification>';

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "have", "you", "are", "was", "but", "not",
  "about", "from", "its", "any", "our", "your", "into", "only", "over", "just", "how", "then",
  "ever", "it's", "does", "did", "can", "will", "there", "their", "they", "them", "who", "why",
]);

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

export interface FixtureSearchCall {
  agentId: string;
  query: string;
  limit: number;
  returned: RecallHit[];
}

export class FixtureStore {
  readonly calls: FixtureSearchCall[] = [];
  readonly clientsBuiltFor: string[] = [];
  private readonly df = new Map<string, number>();

  constructor(readonly memories: readonly FixtureMemory[] = FIXTURE_MEMORIES) {
    for (const m of memories) {
      for (const t of terms(m.content)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  private readable(agentId: string): FixtureMemory[] {
    return this.memories.filter((m) => m.agentId === agentId || m.visibility !== "private");
  }

  /** The search, as `agentId`, in the server's result order (score, then newest). */
  search(agentId: string, query: string, limit: number): RecallHit[] {
    const q = terms(query);
    const n = this.memories.length;
    const scored = this.readable(agentId).map((m) => {
      const shared = [...terms(m.content)].filter((t) => q.has(t));
      const distinctive = shared.filter((t) => (this.df.get(t) ?? 0) * 2 < n);
      const score =
        distinctive.length > 0
          ? Math.min(0.95, 0.8 + 0.03 * (distinctive.length - 1))
          : 0.46 + 0.02 * Math.min(shared.length, 4);
      return { id: m.id, content: m.content, score: Math.round(score * 1000) / 1000, createdAt: m.createdAt };
    });
    scored.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
    const returned = scored.slice(0, limit);
    this.calls.push({ agentId, query, limit, returned });
    return returned;
  }

  /** A `makeClient` for runRecall: records the identity it was built for. */
  readonly factory = (agentId: string): RecallSearchClient => {
    this.clientsBuiltFor.push(agentId);
    return {
      memory: {
        search: async (query: string, opts: { limit: number }) => this.search(agentId, query, opts.limit),
      },
    };
  };
}
