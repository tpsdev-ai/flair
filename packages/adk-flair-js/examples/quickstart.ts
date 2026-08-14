/**
 * adk-flair quickstart (JS/TS) — cross-session recall with a real Gemini model.
 *
 * Runs the Memory Bank ADK quickstart flow against Flair instead of Vertex AI
 * Memory Bank:
 *
 *   1. Build a minimal ADK agent (Gemini) with FlairMemoryService as its memory.
 *   2. Session 1 — the user tells the agent a fact; the after-agent callback
 *      persists the turn to Flair.
 *   3. SETTLE — poll searchMemory until that fact is retrievable (bounded), so
 *      a freshly-booted Flair has finished indexing before we read back. This is
 *      the demo's reliability step; it does NOT change the adapter's production
 *      2s search budget (a deliberate graceful-degradation design).
 *   4. Session 2 — a brand-new session asks for the fact; PRELOAD_MEMORY pulls it
 *      from Flair and the agent answers. We print whether the fact was recalled.
 *
 * ─── Prerequisites (see README.md) ──────────────────────────────────────────
 *   npm i -g @tpsdev-ai/flair && flair init
 *   flair agent add my-adk-app          # writes ~/.flair/keys/my-adk-app.key
 *   export FLAIR_URL=http://localhost:19926
 *   export FLAIR_AGENT_ID=my-adk-app
 *   export FLAIR_KEYFILE=~/.flair/keys/my-adk-app.key
 *   export GOOGLE_API_KEY=...           # or GEMINI_API_KEY
 *
 * ─── Run ─────────────────────────────────────────────────────────────────────
 *   bun run packages/adk-flair-js/examples/quickstart.ts
 *   # or, after `npm install @tpsdev-ai/adk-flair` in your own project:
 *   #   npx tsx quickstart.ts
 *
 * Exit code: 0 = fact recalled, 2 = not recalled, 1 = setup/settle error.
 */

import { FlairMemoryService } from "@tpsdev-ai/adk-flair";
import {
  Agent,
  Runner,
  InMemorySessionService,
  PRELOAD_MEMORY,
} from "@google/adk";
import type { Session, Event } from "@google/adk";
import type { Content } from "@google/genai";
import * as crypto from "node:crypto";

const APP_NAME = "adk-flair-quickstart-js";
// A fresh user id per run keeps the demo idempotent: session 1 and session 2
// share it (that's the cross-session recall), but re-running against the same
// Flair never accumulates conflicting facts under one user. Set FLAIR_DEMO_USER
// to pin a stable identity across runs instead.
const USER_ID =
  process.env["FLAIR_DEMO_USER"] ?? `demo-user-${crypto.randomUUID().slice(0, 8)}`;
const MODEL = process.env["ADK_MODEL"] ?? "gemini-2.5-flash";
const SETTLE_BUDGET_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll searchMemory until the planted token is retrievable, or the budget
 * expires. Returns the number of polls it took, or null on timeout.
 */
async function settle(
  memory: FlairMemoryService,
  token: string,
  budgetMs: number,
): Promise<number | null> {
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const res = await memory.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: token,
    });
    const found = res.memories.some((m) =>
      ((m.content?.parts?.[0] as { text?: string })?.text ?? "")
        .toLowerCase()
        .includes(token.toLowerCase()),
    );
    if (found) return attempt;
    await sleep(500);
  }
  return null;
}

/** Run one agent turn and return all model-authored text concatenated. */
async function runTurn(
  runner: Runner,
  sessionId: string,
  text: string,
): Promise<string> {
  const out: string[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId,
    newMessage: { role: "user", parts: [{ text }] } as Content,
  })) {
    const evt = event as Event;
    if (evt.author === "quickstart_agent") {
      for (const p of evt.content?.parts ?? []) {
        const t = (p as { text?: string }).text;
        if (t) out.push(t);
      }
    }
  }
  return out.join(" ").trim();
}

async function main(): Promise<void> {
  const url = process.env["FLAIR_URL"] ?? "http://localhost:19926";
  const agentId = process.env["FLAIR_AGENT_ID"];
  const keyfile = process.env["FLAIR_KEYFILE"];

  if (!agentId || !keyfile) {
    console.error(
      "Set FLAIR_AGENT_ID and FLAIR_KEYFILE first (see the README quickstart). " +
        "Provision them with `flair agent add <id>`.",
    );
    process.exit(1);
  }
  if (!process.env["GOOGLE_API_KEY"] && !process.env["GEMINI_API_KEY"]) {
    console.error(
      "Set GOOGLE_API_KEY (or GEMINI_API_KEY) to a Gemini API key to run the agent.",
    );
    process.exit(1);
  }

  const memory = new FlairMemoryService({ url, agentId, keyfile });

  // Persist each turn's events to Flair after the agent responds.
  const afterAgentCallback = async (ctx: {
    invocationContext: { session: Session };
  }): Promise<void> => {
    const s = ctx.invocationContext.session;
    await memory.addEventsToMemory(APP_NAME, USER_ID, s.events, s.id);
  };

  const agent = new Agent({
    model: MODEL,
    name: "quickstart_agent",
    instruction:
      "You are a helpful assistant with long-term memory. Use the " +
      "preload_memory tool to recall what you know about the user, and " +
      "remember new facts they tell you.",
    tools: [PRELOAD_MEMORY],
    afterAgentCallback,
  });

  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    agent,
    appName: APP_NAME,
    sessionService,
    memoryService: memory,
  });

  console.log(
    `adk-flair quickstart (JS) — Flair=${url} model=${MODEL} user=${USER_ID}`,
  );

  // ── Session 1: plant a fact ──────────────────────────────────────────────
  const token = `zephyr-${crypto.randomUUID().slice(0, 8)}`;
  const session1 = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  console.log(`\n[session 1] planting fact: favorite code word = '${token}'`);
  const a1 = await runTurn(
    runner,
    session1.id,
    `Remember this about me: my favorite code word is '${token}'. ` +
      `Acknowledge that you've stored it.`,
  );
  console.log(`[session 1] agent: ${a1}`);

  // ── Settle: wait until the fact is retrievable on this (possibly cold) Flair
  console.log(`\n[settle] waiting for the fact to become searchable...`);
  const polls = await settle(memory, token, SETTLE_BUDGET_MS);
  if (polls === null) {
    console.error(
      `[settle] TIMED OUT after ${SETTLE_BUDGET_MS / 1000}s — the fact never ` +
        `became searchable. Is Flair indexing? Is FLAIR_URL correct?`,
    );
    await memory.close();
    process.exit(1);
  }
  console.log(`[settle] fact searchable after ${polls} poll(s)`);

  // ── Session 2: recall in a brand-new session ─────────────────────────────
  const session2 = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  console.log(`\n[session 2] asking: What is my favorite code word?`);
  const a2 = await runTurn(runner, session2.id, "What is my favorite code word?");
  console.log(`[session 2] agent: ${a2}`);

  const recalled = a2.toLowerCase().includes(token.toLowerCase());
  console.log(
    `\nRECALLED: ${recalled ? "yes" : "no"} (planted '${token}', ` +
      `${recalled ? "found" : "not found"} in the session-2 answer)`,
  );

  await memory.close();
  process.exit(recalled ? 0 : 2);
}

main().catch((err) => {
  console.error("quickstart failed:", err);
  process.exit(1);
});
