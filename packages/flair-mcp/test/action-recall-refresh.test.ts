/**
 * Action recall (flair#2067 slice 2) — the SessionStart refresh lane.
 *
 * Covers the refresh contracts the pure module tests cannot reach: the scope
 * gate (a non-own or admin or absent scope writes NO cache), request order
 * (`/Instance` then the bounded own-lesson query), the deadline leaving no
 * usable binding, and the runHook wiring (opt-in via FLAIR_ACTION_RECALL).
 * Hermetic: a per-test temp root, an injected client — nothing touches the real
 * ~/.flair and no network call is made.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REFRESH_CANDIDATES,
  REFRESH_MAX_RESPONSE_BYTES,
  refreshActionRecallCache,
  type ActionRecallRefreshClient,
  type RefreshOptions,
} from "../src/action-recall-refresh.ts";
import { readBinding, sessionDir } from "../src/action-recall-cache.ts";
import { runActionRecall } from "../src/action-recall-run.ts";
import { runHook } from "../src/session-start-hook.ts";

const URL = "http://localhost:19926";
const AGENT = "refresh-agent";
const SESSION = "sess-1";
const INSTANCE = "inst-1";
const NOW = Date.parse("2026-10-03T00:00:00.000Z");

interface Call {
  method: string;
  path: string;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

function trigger() {
  return { verb: "git", subcommands: ["push"], flags: ["--force"], paths: [] };
}

function row(id: string) {
  return {
    id,
    agentId: AGENT,
    content: `lesson ${id}: force push the release branch after the lane passes`,
    createdAt: "2026-10-01T00:00:00.000Z",
    metadata: JSON.stringify({ flairActionRecall: { v: 1, triggers: [trigger()] } }),
  };
}

/** A refresh client whose `request` is driven by `handler`; records every call. */
function fakeClient(handler: (call: Call) => unknown | Promise<unknown>): ActionRecallRefreshClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    bootstrap: async () => ({}),
    request: async (method: string, path: string, _body?: unknown, opts?: { signal?: AbortSignal; maxResponseBytes?: number }) => {
      const call: Call = { method, path, maxResponseBytes: opts?.maxResponseBytes, signal: opts?.signal };
      calls.push(call);
      return await handler(call);
    },
  };
}

/** A request that never settles until its signal aborts (a stalled Flair). */
function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

function baseOpts(overrides: Partial<RefreshOptions> = {}): RefreshOptions {
  return { agentId: AGENT, url: URL, session: SESSION, now: NOW, root, deadlineMs: 3000, ...overrides };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-2067-refresh-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  return sessionDir(root, URL, AGENT, SESSION);
}

describe("refresh scope gate", () => {
  test("refuses an absent, non-own or admin scope and writes nothing", async () => {
    const cases: Array<{ label: string; scope: { agentId?: string; isAdmin?: boolean } | undefined }> = [
      { label: "absent", scope: undefined },
      { label: "other agent", scope: { agentId: "someone-else", isAdmin: false } },
      { label: "admin", scope: { agentId: AGENT, isAdmin: true } },
      { label: "missing isAdmin", scope: { agentId: AGENT } },
    ];
    for (const c of cases) {
      const client = fakeClient(() => ({}));
      const result = await refreshActionRecallCache(
        client,
        baseOpts({ root, bootstrapResult: c.scope ? { scope: c.scope } : undefined }),
      );
      expect(result.ok, c.label).toBe(false);
      expect(result.reason, c.label).toBe("scope");
      expect(client.calls.length, c.label).toBe(0);
      expect(existsSync(dir()), c.label).toBe(false);
    }
  });
});

describe("refresh reads and publishes", () => {
  test("reads /Instance then the newest 256 own lessons under the 8 MiB cap", async () => {
    const client = fakeClient((call) => (call.path === "/Instance" ? [{ id: INSTANCE }] : [row("mem-1"), row("mem-2")]));
    const result = await refreshActionRecallCache(client, baseOpts({ root, bootstrapResult: { scope: { agentId: AGENT, isAdmin: false } } }));
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(2);

    expect(client.calls[0].path).toBe("/Instance");
    expect(client.calls[0].method).toBe("GET");
    const memory = client.calls[1];
    expect(memory.path).toContain(`sort(-createdAt)&limit(0,${REFRESH_CANDIDATES})`);
    expect(memory.path).toContain(encodeURIComponent(AGENT));
    for (const call of client.calls) {
      expect(call.maxResponseBytes).toBe(REFRESH_MAX_RESPONSE_BYTES);
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }

    const binding = await readBinding(dir(), { url: URL, principal: AGENT, session: SESSION });
    expect(binding).not.toBeNull();
    expect(binding?.instance).toBe(INSTANCE);

    // The hot path reads the published generation back and surfaces the lesson.
    const out = await runActionRecall(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: "/repo", session_id: SESSION }),
      { root, env: { FLAIR_AGENT_ID: AGENT, FLAIR_URL: URL } as NodeJS.ProcessEnv, now: NOW, cwd: "/repo" },
    );
    expect(out).toContain("mem-1");
  });

  test("an own row without triggers, a foreign row and an ineligible row are excluded", async () => {
    const untriggered = { id: "no-trig", agentId: AGENT, content: "x", metadata: JSON.stringify({ other: 1 }) };
    const foreign = { ...row("foreign"), agentId: "other" };
    const archived = { ...row("archived"), archived: true };
    const live = row("live");
    const client = fakeClient((call) => (call.path === "/Instance" ? [{ id: INSTANCE }] : [untriggered, foreign, archived, live]));
    const result = await refreshActionRecallCache(client, baseOpts({ root, bootstrapResult: { scope: { agentId: AGENT, isAdmin: false } } }));
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(1);
  });

  test("refuses unless exactly one instance identity is returned", async () => {
    for (const instanceRows of [[], [{ id: "a" }, { id: "b" }], [{ id: "" }], {}]) {
      const client = fakeClient((call) => (call.path === "/Instance" ? instanceRows : [row("mem-1")]));
      const result = await refreshActionRecallCache(client, baseOpts({ root, bootstrapResult: { scope: { agentId: AGENT, isAdmin: false } } }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("instance");
      // The binding was invalidated before the read and never re-published.
      expect(await readBinding(dir(), { url: URL, principal: AGENT, session: SESSION })).toBeNull();
    }
  });

  test("a deadline leaves no usable binding (no late write)", async () => {
    const client = fakeClient((call) => (call.path === "/Instance" ? hangUntilAborted(call.signal) : [row("mem-1")]));
    const result = await refreshActionRecallCache(client, baseOpts({ root, deadlineMs: 40, bootstrapResult: { scope: { agentId: AGENT, isAdmin: false } } }));
    expect(result.ok).toBe(false);
    expect(await readBinding(dir(), { url: URL, principal: AGENT, session: SESSION })).toBeNull();
  });
});

describe("runHook wiring", () => {
  const ORIGINAL = {
    FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID,
    FLAIR_URL: process.env.FLAIR_URL,
    FLAIR_ACTION_RECALL: process.env.FLAIR_ACTION_RECALL,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("opt-in refresh with the agent's own non-admin scope publishes the cache", async () => {
    process.env.FLAIR_AGENT_ID = AGENT;
    process.env.FLAIR_URL = URL;
    process.env.FLAIR_ACTION_RECALL = "1";
    const client = fakeClient((call) => (call.path === "/Instance" ? [{ id: INSTANCE }] : [row("mem-1")]));
    const out = await runHook(
      JSON.stringify({ cwd: "/repo", source: "startup", session_id: SESSION }),
      () => ({ bootstrap: async () => ({ context: "## Identity", scope: { agentId: AGENT, isAdmin: false } }) }),
      { makeRecallClient: () => client, actionRecallRoot: root, now: NOW },
    );
    expect(out).toContain("## Identity");
    expect(await readBinding(dir(), { url: URL, principal: AGENT, session: SESSION })).not.toBeNull();
  });

  test("no refresh without the opt-in flag", async () => {
    process.env.FLAIR_AGENT_ID = AGENT;
    process.env.FLAIR_URL = URL;
    delete process.env.FLAIR_ACTION_RECALL;
    const client = fakeClient(() => ({ id: INSTANCE }));
    await runHook(
      JSON.stringify({ cwd: "/repo", source: "startup", session_id: SESSION }),
      () => ({ bootstrap: async () => ({ context: "## Identity", scope: { agentId: AGENT, isAdmin: false } }) }),
      { makeRecallClient: () => client, actionRecallRoot: root, now: NOW },
    );
    expect(client.calls.length).toBe(0);
    expect(existsSync(dir())).toBe(false);
  });
});
