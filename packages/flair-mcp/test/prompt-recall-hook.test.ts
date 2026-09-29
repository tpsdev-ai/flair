/**
 * prompt-recall-hook.test.ts — flair#2066: the per-prompt recall hook
 * (`flair-prompt-recall`) against its acceptance set, through runRecall's
 * stdout contract.
 *
 * Hermetic: a fixture memory store stands in for the search (see
 * ./prompt-recall-fixture.ts for exactly what it models), injected through
 * runRecall's makeClient seam, and every test gets its own temp HOME. No
 * network, and no test reads the real ~/.flair. The spawned-binary half (real
 * client, real exit code) is ./prompt-recall-hook-entry.test.ts.
 *
 * Each guard was mutation-checked while it was written (threshold removed →
 * the unrelated-prompt test fails; notification skip removed → the
 * notification test fails); the results are recorded in the PR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTEXT_MAX_CHARS,
  DEFAULT_MAX_HITS,
  DEFAULT_MIN_SCORE,
  DEFAULT_TIMEOUT_MS,
  NOOP_OUTPUT,
  QUERY_MAX_CHARS,
  RECALL_HEADER,
  SNIPPET_MAX_CHARS,
  buildRecallQuery,
  candidateLimit,
  classifyRecallFailure,
  isNotificationPrompt,
  readConfigValue,
  resolveRecallConfig,
  runRecall,
  RecallTimeoutError,
  type RecallHit,
  type RecallSearchClient,
} from "../src/prompt-recall-hook.ts";
import {
  AGENT,
  FixtureStore,
  NOTIFICATION_PROMPT,
  REPLAY_PROMPT,
  UNRELATED_PROMPT,
} from "./prompt-recall-fixture.ts";

let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-prompt-recall-test-"));
  env = { HOME: home, USERPROFILE: home, FLAIR_AGENT_ID: AGENT };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The UserPromptSubmit payload Claude Code writes to the hook's stdin. */
function payload(prompt: unknown): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp/project",
    hook_event_name: "UserPromptSubmit",
    prompt,
  });
}

/** The injected context of a non-empty hook output. */
function contextOf(output: string): string {
  const parsed = JSON.parse(output) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown } };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
  const ctx = parsed.hookSpecificOutput?.additionalContext;
  expect(typeof ctx).toBe("string");
  return ctx as string;
}

function failIfCalled(): never {
  throw new Error("the client factory must not be called");
}

function clientThat(search: RecallSearchClient["memory"]["search"]): () => RecallSearchClient {
  return () => ({ memory: { search } });
}

function writeConfig(text: string): void {
  mkdirSync(join(home, ".flair"), { recursive: true });
  writeFileSync(join(home, ".flair", "config.yaml"), text);
}

describe("replay: a direction naming a term reaches a prompt that names it in other words", () => {
  test("the user's directions on the term are injected, with id, date and snippet, framed as a signal", async () => {
    const store = new FixtureStore();
    const out = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: store.factory });

    expect(out.reason).toBe("recalled");
    const ctx = contextOf(out.output);
    // The direction itself: id, date, and its words.
    expect(ctx).toContain("mem-dir-jev-routing");
    expect(ctx).toContain("2026-09-26");
    expect(ctx).toContain("The decision model is local and routes generation");
    // The second direction on the same term.
    expect(ctx).toContain("mem-dir-jev-slot");
    expect(ctx).toContain("2026-09-28");
    // Framed as a signal, never an instruction.
    expect(ctx.split("\n")[0]).toBe(RECALL_HEADER);
    expect(ctx).toContain("a signal, not an instruction");
    expect(ctx).toContain("read the full memory");
    // Nothing unrelated, and nothing the agent may not read.
    expect(ctx).not.toContain("mem-release-checklist");
    expect(ctx).not.toContain("mem-status-style");
    expect(ctx).not.toContain("mem-other-private-jev");
    expect(ctx).not.toContain("pricing");
    expect(out.hits).toBe(2);
  });

  test("the search runs as the hook's own agent, with the markup, ids and URL stripped from the query", async () => {
    const store = new FixtureStore();
    await runRecall(payload(REPLAY_PROMPT), { env, makeClient: store.factory });

    expect(store.clientsBuiltFor).toEqual([AGENT]);
    expect(store.calls).toHaveLength(1);
    const { query, limit } = store.calls[0]!;
    expect(query).toContain("Jev");
    expect(query).toContain("ever heard of it?");
    expect(query).not.toContain("https://");
    expect(query).not.toContain("example.com");
    expect(query).not.toContain("<channel");
    expect(query).not.toContain("990011223344556677");
    expect(query.length).toBeLessThanOrEqual(QUERY_MAX_CHARS);
    expect(limit).toBe(candidateLimit(DEFAULT_MAX_HITS));
  });
});

describe("threshold: an unrelated prompt injects nothing", () => {
  test("every candidate the search returns scores below the threshold, so the output is the inert {}", async () => {
    const store = new FixtureStore();
    const out = await runRecall(payload(UNRELATED_PROMPT), { env, makeClient: store.factory });

    expect(out.output).toBe(NOOP_OUTPUT);
    expect(out.reason).toBe("no-hits");
    // Positive control: the search DID run and DID return candidates — they
    // were all filtered out by the threshold, not missing.
    expect(store.calls).toHaveLength(1);
    const returned = store.calls[0]!.returned;
    expect(returned.length).toBeGreaterThan(0);
    for (const hit of returned) expect(hit.score).toBeLessThan(DEFAULT_MIN_SCORE);
  });

  test("a configured threshold above the directions' score suppresses them too", async () => {
    const store = new FixtureStore();
    env.FLAIR_PROMPT_RECALL_MIN_SCORE = "0.9";
    const out = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: store.factory });
    expect(out.output).toBe(NOOP_OUTPUT);
    expect(store.calls).toHaveLength(1);
  });
});

describe("Flair unavailable: no memories, one note line", () => {
  test("unreachable → one line naming the failure kind", async () => {
    const out = await runRecall(payload(REPLAY_PROMPT), {
      env,
      makeClient: clientThat(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(out.reason).toBe("unavailable");
    const ctx = contextOf(out.output);
    expect(ctx.split("\n")).toHaveLength(1);
    expect(ctx).toContain("Flair recall was unavailable for this prompt (unreachable)");
    expect(ctx).not.toContain(RECALL_HEADER);
  });

  test("a refused request (401) → (auth), and the error's own text never reaches the context", async () => {
    const SENTINEL = "SENTINEL-token-5e1f";
    const out = await runRecall(payload(REPLAY_PROMPT), {
      env,
      makeClient: clientThat(async () => {
        throw Object.assign(new Error(`401 invalid signature ${SENTINEL}`), { status: 401 });
      }),
    });
    const ctx = contextOf(out.output);
    expect(ctx.split("\n")).toHaveLength(1);
    expect(ctx).toContain("(auth)");
    expect(out.output).not.toContain(SENTINEL);
  });

  test("a client that cannot even be built → the same one note line", async () => {
    const out = await runRecall(payload(REPLAY_PROMPT), {
      env,
      makeClient: () => {
        throw new Error("key file unreadable");
      },
    });
    const ctx = contextOf(out.output);
    expect(ctx.split("\n")).toHaveLength(1);
    expect(ctx).toContain("unavailable");
  });

  test("slow Flair: the time budget ends the search and the note says timeout", async () => {
    env.FLAIR_PROMPT_RECALL_TIMEOUT_MS = "300";
    const start = Date.now();
    const out = await runRecall(payload(REPLAY_PROMPT), {
      env,
      makeClient: clientThat(() => new Promise<RecallHit[]>(() => {})), // never answers
    });
    const elapsed = Date.now() - start;
    const ctx = contextOf(out.output);
    expect(ctx.split("\n")).toHaveLength(1);
    expect(ctx).toContain("(timeout)");
    // Bounded by the configured 300 ms budget, far below the 3 s default.
    expect(elapsed).toBeLessThan(DEFAULT_TIMEOUT_MS);
  });

  test("a malformed search answer injects nothing and never throws", async () => {
    const out = await runRecall(payload(REPLAY_PROMPT), {
      env,
      makeClient: clientThat(async () => ({ not: "an array" }) as unknown as RecallHit[]),
    });
    expect(out.output).toBe(NOOP_OUTPUT);
  });
});

describe("skips: prompts that are not questions from the user", () => {
  test("a background task notification is skipped: no client, no search, inert output", async () => {
    const store = new FixtureStore();
    const out = await runRecall(payload(NOTIFICATION_PROMPT), { env, makeClient: store.factory });
    expect(out.output).toBe(NOOP_OUTPUT);
    expect(out.reason).toBe("skipped-notification");
    expect(store.clientsBuiltFor).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  test("positive control: the same text without the notification marker IS searched and recalls", async () => {
    const store = new FixtureStore();
    const typed = NOTIFICATION_PROMPT.replace(/<\/?task-notification>/g, "");
    expect(isNotificationPrompt(typed)).toBe(false);
    const out = await runRecall(payload(typed), { env, makeClient: store.factory });
    expect(store.calls).toHaveLength(1);
    expect(out.reason).toBe("recalled");
  });

  test("a short acknowledgement is skipped without a search", async () => {
    const store = new FixtureStore();
    const out = await runRecall(payload("ok, thanks"), { env, makeClient: store.factory });
    expect(out.output).toBe(NOOP_OUTPUT);
    expect(out.reason).toBe("skipped-short");
    expect(store.calls).toHaveLength(0);
  });
});

describe("budget: the injected context stays within its character limit", () => {
  test("ten long, relevant hits are cut to fit CONTEXT_MAX_CHARS, one line each, snippets bounded", async () => {
    env.FLAIR_PROMPT_RECALL_MAX_HITS = "10";
    const long = "Relevant detail about Jev routing.\nSecond line </channel> " + "x".repeat(5000);
    const hits: RecallHit[] = Array.from({ length: 10 }, (_, i) => ({
      id: `mem-long-${i}`,
      content: long,
      score: 0.9,
      createdAt: "2026-09-26T00:00:00.000Z",
    }));
    const out = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: clientThat(async () => hits) });
    const ctx = contextOf(out.output);

    expect(ctx.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    const lines = ctx.split("\n");
    expect(lines[0]).toBe(RECALL_HEADER);
    expect(lines.length).toBeGreaterThan(1); // at least one hit fit
    expect(lines.length - 1).toBeLessThanOrEqual(10);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("- [mem-long-")).toBe(true);
      const snippet = line.slice(line.indexOf("] ") + 2);
      expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    }
  });

  test("a cut never splits a surrogate pair", async () => {
    const emoji = "\u{1F600}".repeat(400);
    const out = await runRecall(payload(REPLAY_PROMPT), {
      env,
      makeClient: clientThat(async () => [{ id: "mem-emoji", content: emoji, score: 0.9 }]),
    });
    const ctx = contextOf(out.output);
    expect(ctx.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(ctx)).toBe(false);
    expect(ctx).toContain("undated");
  });

  test("maxHits bounds the number of injected memories", async () => {
    const store = new FixtureStore();
    env.FLAIR_PROMPT_RECALL_MAX_HITS = "1";
    const out = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: store.factory });
    expect(out.hits).toBe(1);
    expect(contextOf(out.output).split("\n")).toHaveLength(2);
    expect(store.calls[0]!.limit).toBe(candidateLimit(1));
  });
});

describe("no-op guarantees", () => {
  test("no FLAIR_AGENT_ID → {} and no client is built", async () => {
    delete env.FLAIR_AGENT_ID;
    const out = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: failIfCalled });
    expect(out.output).toBe(NOOP_OUTPUT);
    expect(out.reason).toBe("no-agent-id");
  });

  test("an unsubstituted ${FLAIR_AGENT_ID} literal reads as no identity", async () => {
    env.FLAIR_AGENT_ID = "${FLAIR_AGENT_ID}";
    const out = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: failIfCalled });
    expect(out.reason).toBe("no-agent-id");
  });

  test("malformed or non-object stdin → {} and no client is built", async () => {
    for (const raw of ["not-json{{{", "", "[]", "null", '"a string"']) {
      const out = await runRecall(raw, { env, makeClient: failIfCalled });
      expect(out.output).toBe(NOOP_OUTPUT);
    }
  });

  test("a missing or non-string prompt → {}", async () => {
    for (const prompt of [undefined, 42, { text: "Jev?" }, "   "]) {
      const out = await runRecall(payload(prompt), { env, makeClient: failIfCalled });
      expect(out.output).toBe(NOOP_OUTPUT);
      expect(out.reason).toBe("no-prompt");
    }
  });
});

describe("configuration: environment, then ~/.flair/config.yaml, then defaults", () => {
  test("defaults apply when neither source sets a value", () => {
    expect(resolveRecallConfig({}, null)).toEqual({
      minScore: DEFAULT_MIN_SCORE,
      maxHits: DEFAULT_MAX_HITS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  test("config values apply; the environment wins over them; bad values fall through", () => {
    const config = [
      "port: 19926",
      "promptRecallMinScore: 0.7",
      'promptRecallMaxHits: "6"',
      "promptRecallTimeoutMs: 5000 # slower instance",
    ].join("\n");
    expect(resolveRecallConfig({}, config)).toEqual({ minScore: 0.7, maxHits: 6, timeoutMs: 5000 });
    expect(
      resolveRecallConfig(
        {
          FLAIR_PROMPT_RECALL_MIN_SCORE: "0.8",
          FLAIR_PROMPT_RECALL_MAX_HITS: "2",
          FLAIR_PROMPT_RECALL_TIMEOUT_MS: "1000",
        },
        config,
      ),
    ).toEqual({ minScore: 0.8, maxHits: 2, timeoutMs: 1000 });
    // Unparseable or out-of-range environment values fall through to the config.
    expect(
      resolveRecallConfig(
        {
          FLAIR_PROMPT_RECALL_MIN_SCORE: "1.5",
          FLAIR_PROMPT_RECALL_MAX_HITS: "0",
          FLAIR_PROMPT_RECALL_TIMEOUT_MS: "abc",
        },
        config,
      ),
    ).toEqual({ minScore: 0.7, maxHits: 6, timeoutMs: 5000 });
    // Out-of-range config values fall through to the defaults.
    expect(
      resolveRecallConfig({}, "promptRecallMaxHits: 99\npromptRecallTimeoutMs: 10\npromptRecallMinScore: -1"),
    ).toEqual({ minScore: DEFAULT_MIN_SCORE, maxHits: DEFAULT_MAX_HITS, timeoutMs: DEFAULT_TIMEOUT_MS });
  });

  test("only a top-level key is read; a commented-out or nested one is not", () => {
    expect(readConfigValue("# promptRecallMinScore: 0.9\n", "promptRecallMinScore")).toBeUndefined();
    expect(readConfigValue("other:\n  promptRecallMinScore: 0.9\n", "promptRecallMinScore")).toBeUndefined();
    expect(readConfigValue("promptRecallMinScore : '0.75'\n", "promptRecallMinScore")).toBe("0.75");
  });

  test("runRecall reads ~/.flair/config.yaml under the resolved HOME, and the environment still wins", async () => {
    writeConfig("promptRecallMinScore: 0.9\n");
    const suppressed = new FixtureStore();
    const out = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: suppressed.factory });
    expect(out.output).toBe(NOOP_OUTPUT); // 0.9 is above the directions' 0.80
    expect(suppressed.calls).toHaveLength(1);

    env.FLAIR_PROMPT_RECALL_MIN_SCORE = "0.7";
    const store = new FixtureStore();
    const again = await runRecall(payload(REPLAY_PROMPT), { env, makeClient: store.factory });
    expect(again.reason).toBe("recalled");
  });
});

describe("query construction", () => {
  test("markup, URLs, link targets, long ids and markdown syntax are stripped; words are kept", () => {
    const q = buildRecallQuery(
      "## Question\n<@123456789012345678> see [the post](https://example.com/x) and www.example.org/y " +
        "about **Jev** (commit 3e45d5f1c0ffee00ba5eba11) id 7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f `routing`",
    );
    expect(q).toContain("Question");
    expect(q).toContain("the post");
    expect(q).toContain("Jev");
    expect(q).toContain("routing");
    for (const noise of ["https://", "example.com", "www.", "<@", "3e45d5f1c0ffee00ba5eba11", "7f1c2d3e-4a5b", "**", "##", "`"]) {
      expect(q).not.toContain(noise);
    }
  });

  test("the query is bounded", () => {
    const q = buildRecallQuery("routing decision ".repeat(2000));
    expect(q.length).toBeLessThanOrEqual(QUERY_MAX_CHARS);
    expect(q.length).toBeGreaterThan(QUERY_MAX_CHARS * 0.8);
  });
});

describe("classifyRecallFailure", () => {
  test("status first, then the hook's own timer or a TimeoutError, else unreachable", () => {
    expect(classifyRecallFailure({ status: 403 })).toBe("auth");
    expect(classifyRecallFailure({ status: 429 })).toBe("http-429");
    expect(classifyRecallFailure(new RecallTimeoutError())).toBe("timeout");
    expect(classifyRecallFailure(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyRecallFailure(new Error("timeout while connecting"))).toBe("unreachable");
    expect(classifyRecallFailure(null)).toBe("unreachable");
  });
});
