/**
 * continuity-hook.test.ts — flair#1257 slice 2: the Claude Code continuity
 * hook adapter (capture bin + SessionStart resume path), tested against the
 * merged acceptance set on the issue (S1–S10) and Sherlock's capture-content
 * rulings.
 *
 * LEAK-GUARD PROTOCOL: every filter/bound test here has a POSITIVE CONTROL —
 * the same marker planted in the field that IS allowed to flow (a Bash
 * description, an in-bound Stop excerpt, a file path) must be observed in the
 * write body. Without the control, a capture bin that stopped writing
 * anything at all would pass every "marker absent" assertion (an unrun check
 * must not look like a pass). Each guard was additionally mutation-checked
 * during development (filter/bound broken → red, restored → green); the
 * results are recorded in the PR.
 *
 * Everything is hermetic: injected clients (zero network), per-test temp dirs
 * for the pointer/state files (FLAIR_SESSION_DIR / explicit sessionDir deps —
 * the homeOverride discipline; no test ever touches the real ~/.flair).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NOTE (CI ordering): this file runs in the ROOT `bun test test/unit/` lane,
// which executes BEFORE flair-client's dist/ is built. Everything imported
// here is therefore dist-free by construction: continuity.ts imports only
// node builtins, and continuity-capture-hook.ts imports @tpsdev-ai/flair-client
// LAZILY (only the real binary's default client factory ever resolves it).
// The runHook end-to-end resume tests live in
// packages/flair-mcp/test/continuity-resume.test.ts — that lane builds
// flair-client first. See the matching note in test/unit/hook-install.test.ts.
import {
  CAPTURE_BOUND_CHARS,
  CONTINUITY_TAG_PREFIX,
  MUTATING_TOOLS,
  buildJournalRow,
  buildResumeHint,
  bumpSeq,
  continuityTag,
  discoverResume,
  hardBound,
  isSafeFileId,
  planCapture,
  pointerPath,
  prepareContinuityBoot,
  readPointer,
  readState,
  seedSession,
  statePath,
  type ContinuityClient,
  type SessionPointer,
} from "../../packages/flair-mcp/src/continuity.ts";
import { runCapture, type CaptureDeps } from "../../packages/flair-mcp/src/continuity-capture-hook.ts";

const AGENT = "agent-a";
const HARNESS_SESSION = "claude-sess-1";

const ORIGINAL_ENV = {
  FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID,
  FLAIR_SESSION_DIR: process.env.FLAIR_SESSION_DIR,
  FLAIR_CONTINUITY_TIMEOUT_MS: process.env.FLAIR_CONTINUITY_TIMEOUT_MS,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-continuity-test-"));
  // Belt-and-suspenders: even a code path that ignores injected deps and
  // falls back to env must land in the temp dir, never the real ~/.flair.
  process.env.FLAIR_SESSION_DIR = dir;
  delete process.env.FLAIR_AGENT_ID;
  delete process.env.FLAIR_CONTINUITY_TIMEOUT_MS;
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A client that records every request and answers from a canned map. */
function recordingClient(respond?: (method: string, path: string, body: unknown) => unknown) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const client: ContinuityClient = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return (respond ? respond(method, path, body) : {}) as any;
    },
  };
  return { calls, client };
}

function captureDeps(overrides: Partial<CaptureDeps> = {}) {
  const { calls, client } = recordingClient();
  const warnings: string[] = [];
  const deps: CaptureDeps = {
    env: { FLAIR_AGENT_ID: AGENT },
    sessionDir: dir,
    makeClient: () => client,
    warn: (m) => warnings.push(m),
    ...overrides,
  };
  return { calls, client, warnings, deps };
}

function postToolUse(tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: HARNESS_SESSION,
    tool_name: tool,
    tool_input: toolInput,
    ...extra,
  });
}

function stopInput(fields: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: "Stop", session_id: HARNESS_SESSION, ...fields });
}

/** Journal row shape for resume stubs. */
function row(opts: {
  seq?: number;
  processUUID?: string;
  sessionId: string;
  createdAt?: string;
  expiresAt?: string;
  content?: string;
}) {
  return {
    id: `${AGENT}-${Math.random().toString(36).slice(2)}`,
    agentId: AGENT,
    content: opts.content ?? "bash: something",
    durability: "ephemeral",
    visibility: "private",
    tags: [continuityTag(opts.sessionId)],
    sessionId: opts.sessionId,
    createdAt: opts.createdAt ?? "2026-08-19T10:00:00.000Z",
    expiresAt: opts.expiresAt ?? "2999-01-01T00:00:00.000Z",
    meta: {
      seq: opts.seq ?? 1,
      processUUID: opts.processUUID ?? "proc-1",
      sessionId: opts.sessionId,
    },
  };
}

// ─── capture discipline (S6 + Sherlock rulings) ─────────────────────────────

describe("capture: mutating-tool allowlist", () => {
  test("the allowlist is the exact closed set the spec names (auditable)", () => {
    expect([...MUTATING_TOOLS]).toEqual(["Write", "Edit", "NotebookEdit", "Bash"]);
  });

  test("a read-only tool fires ⇒ ZERO writes, no client ever built, no seq burned", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "TotallyUnknownTool"]) {
      const outcome = await runCapture(postToolUse(tool, { file_path: "/x" }), {
        env: { FLAIR_AGENT_ID: AGENT },
        sessionDir: dir,
        makeClient: () => {
          throw new Error("client must not be constructed for a read-only tool");
        },
      });
      expect(outcome.wrote).toBe(false);
      expect(outcome.reason).toBe("not-capturable");
    }
    // No seq was consumed by any of the skipped fires.
    expect(readState(dir, AGENT, HARNESS_SESSION)?.seq).toBe(0);
  });

  test("a capturable fire writes EXACTLY one row", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    const outcome = await runCapture(postToolUse("Write", { file_path: "/tmp/a.ts" }), deps);
    expect(outcome.wrote).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path.startsWith("/Memory/")).toBe(true);
  });
});

describe("capture: Bash journals the description ONLY — never the command (leak-guard)", () => {
  const CMD_MARKER = "LEAKMARKER_ARGV_c4f9";

  test("command string planted with a marker never reaches the write body", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(
      postToolUse("Bash", {
        command: `export TOKEN=${CMD_MARKER}; ./deploy.sh --now`,
        description: "Deploy the release",
      }),
      deps,
    );
    expect(calls).toHaveLength(1);
    const bodyJson = JSON.stringify(calls[0].body);
    expect(bodyJson).not.toContain(CMD_MARKER);
    expect(calls[0].body.content).toBe("bash: Deploy the release");
  });

  test("POSITIVE CONTROL: the same marker in the description field IS captured (the fixture can express the leak)", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(postToolUse("Bash", { command: "true", description: `note ${CMD_MARKER}` }), deps);
    expect(JSON.stringify(calls[0].body)).toContain(CMD_MARKER);
  });

  test("no description ⇒ the literal placeholder — NEVER a fallback to the command", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(postToolUse("Bash", { command: `secret-cmd ${CMD_MARKER}` }), deps);
    expect(calls[0].body.content).toBe("bash: (no description)");
    expect(JSON.stringify(calls[0].body)).not.toContain(CMD_MARKER);
  });
});

describe("capture: Write/Edit/NotebookEdit journal the file path only — never content/diffs (leak-guard)", () => {
  const CONTENT_MARKER = "LEAKMARKER_CONTENT_8b2d";

  test("Write: planted file content never reaches the write body; the path does (its own positive control)", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(
      postToolUse("Write", { file_path: "/tmp/project/config.ts", content: `API_KEY=${CONTENT_MARKER}`, file_text: `also ${CONTENT_MARKER}` }),
      deps,
    );
    const bodyJson = JSON.stringify(calls[0].body);
    expect(bodyJson).not.toContain(CONTENT_MARKER);
    expect(calls[0].body.content).toBe("write: /tmp/project/config.ts");
  });

  test("Edit: old_string/new_string (the diff) never reach the write body", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(
      postToolUse("Edit", { file_path: "/tmp/a.ts", old_string: `x=${CONTENT_MARKER}`, new_string: `y=${CONTENT_MARKER}` }),
      deps,
    );
    const bodyJson = JSON.stringify(calls[0].body);
    expect(bodyJson).not.toContain(CONTENT_MARKER);
    expect(calls[0].body.content).toBe("edit: /tmp/a.ts");
  });

  test("NotebookEdit: path only (notebook_path or file_path spelling), never the cell source", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(
      postToolUse("NotebookEdit", { notebook_path: "/tmp/nb.ipynb", new_source: `cell ${CONTENT_MARKER}` }),
      deps,
    );
    expect(JSON.stringify(calls[0].body)).not.toContain(CONTENT_MARKER);
    expect(calls[0].body.content).toBe("notebook-edit: /tmp/nb.ipynb");
  });

  test("raw hook JSON fields (tool_result, transcript_path, cwd) are never copied into the row", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(
      postToolUse(
        "Write",
        { file_path: "/tmp/a.ts" },
        {
          tool_result: `raw output ${CONTENT_MARKER}`,
          tool_response: { out: `more ${CONTENT_MARKER}` },
          transcript_path: `/private/${CONTENT_MARKER}.jsonl`,
          cwd: `/work/${CONTENT_MARKER}`,
        },
      ),
      deps,
    );
    expect(JSON.stringify(calls[0].body)).not.toContain(CONTENT_MARKER);
  });
});

describe("capture: Stop excerpt — bounded assistant-chosen prose (Sherlock ruling)", () => {
  test("last_assistant_message becomes a bounded excerpt", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(stopInput({ last_assistant_message: "Merged the PR; next: notify the team." }), deps);
    expect(calls[0].body.content).toBe("stop: Merged the PR; next: notify the team.");
    expect(calls[0].body.meta.hook).toBe("Stop");
  });

  test("a dedicated summary field is PREFERRED over the raw final text", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(
      stopInput({ summary: "was about to merge, waiting on review", last_assistant_message: "long prose that should lose" }),
      deps,
    );
    expect(calls[0].body.content).toBe("stop: was about to merge, waiting on review");
    expect(JSON.stringify(calls[0].body)).not.toContain("should lose");
  });

  test("HARD 400-char truncate with a visible ellipsis: a secret-shaped token BEYOND the bound never reaches the body", async () => {
    // The bound is load-bearing (capture-full-text is a regression) — this
    // test is the tripwire for that regression.
    const SECRET_BEYOND = "sk_live_LEAKMARKER_BEYOND_400_7e1a";
    const padding = "x".repeat(CAPTURE_BOUND_CHARS + 10);
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(stopInput({ last_assistant_message: `${padding} ${SECRET_BEYOND}` }), deps);
    const content: string = calls[0].body.content;
    expect(JSON.stringify(calls[0].body)).not.toContain(SECRET_BEYOND);
    expect(content.length).toBe(CAPTURE_BOUND_CHARS + 1); // 400 chars + the ellipsis
    expect(content.endsWith("…")).toBe(true);
  });

  test("POSITIVE CONTROL: the same token INSIDE the first 400 chars IS captured (the bound, not a scrubber, is the control)", async () => {
    const SECRET_WITHIN = "sk_live_LEAKMARKER_WITHIN_400_7e1a";
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(stopInput({ last_assistant_message: `Done. ${SECRET_WITHIN} was already user-visible prose.` }), deps);
    expect(JSON.stringify(calls[0].body)).toContain(SECRET_WITHIN);
  });

  test("empty / missing / whitespace final text ⇒ NO journal row (no placeholder, no tool-result synthesis)", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    for (const fields of [{}, { last_assistant_message: "" }, { last_assistant_message: "   \n " }, { last_assistant_message: 42 }]) {
      const { calls, deps } = captureDeps();
      const outcome = await runCapture(stopInput(fields), deps);
      expect(outcome.wrote).toBe(false);
      expect(calls).toHaveLength(0);
    }
    expect(readState(dir, AGENT, HARNESS_SESSION)?.seq).toBe(0);
  });

  test("hardBound is a single uniform bound (no variable-length excerpts)", () => {
    expect(hardBound("short")).toBe("short");
    const long = "y".repeat(CAPTURE_BOUND_CHARS * 3);
    expect(hardBound(long).length).toBe(CAPTURE_BOUND_CHARS + 1);
    expect(hardBound(long).endsWith("…")).toBe(true);
  });
});

describe("capture: row shape — the S6 invariants on EVERY write body", () => {
  test("durability ephemeral, visibility private EXPLICIT, one continuity tag, meta {seq, processUUID, sessionId, hook, tool?}", async () => {
    const seeded = seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(postToolUse("Bash", { description: "step one" }), deps);
    await runCapture(postToolUse("Edit", { file_path: "/tmp/b.ts" }), deps);
    await runCapture(stopInput({ last_assistant_message: "wrapping up" }), deps);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const body = call.body;
      expect(body.durability).toBe("ephemeral");
      // EXPLICIT private — never omitted to ride the durability-keyed default
      // (defense-in-depth above the #1261 server guard).
      expect(body.visibility).toBe("private");
      expect(body.tags).toEqual([`${CONTINUITY_TAG_PREFIX}${seeded.sessionId}`]);
      expect(body.sessionId).toBe(seeded.sessionId);
      expect(body.agentId).toBe(AGENT);
      expect(body.meta.processUUID).toBe(seeded.processUUID);
      expect(body.meta.sessionId).toBe(seeded.sessionId);
      expect(typeof body.meta.seq).toBe("number");
    }
    expect(calls[0].body.meta.hook).toBe("PostToolUse");
    expect(calls[0].body.meta.tool).toBe("Bash");
    expect(calls[1].body.meta.tool).toBe("Edit");
    expect(calls[2].body.meta.hook).toBe("Stop");
    expect(calls[2].body.meta.tool).toBeUndefined();
  });

  test("seq is monotonic across fires and persisted in the state file (atomic increment)", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps();
    await runCapture(postToolUse("Bash", { description: "one" }), deps);
    await runCapture(postToolUse("Bash", { description: "two" }), deps);
    await runCapture(postToolUse("Bash", { description: "three" }), deps);
    expect(calls.map((c) => c.body.meta.seq)).toEqual([1, 2, 3]);
    expect(readState(dir, AGENT, HARNESS_SESSION)?.seq).toBe(3);
  });

  test("even a FAILED write burns its seq — gaps are fine, duplicates are not", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const failing = captureDeps({
      makeClient: () => ({
        request: async () => {
          throw new Error("HTTP 500");
        },
      }),
    });
    await runCapture(postToolUse("Bash", { description: "will fail" }), failing.deps);
    const ok = captureDeps();
    await runCapture(postToolUse("Bash", { description: "will land" }), ok.deps);
    expect(ok.calls[0].body.meta.seq).toBe(2);
  });
});

describe("capture: fail-open (S9/S10 — a hook must never block the turn)", () => {
  test("malformed hook JSON ⇒ ZERO writes, zero client construction, clean return (no partial extraction)", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    for (const raw of ["not-json{{{", "", "null", "[1,2,3]", '"just a string"', "42"]) {
      const outcome = await runCapture(raw, {
        env: { FLAIR_AGENT_ID: AGENT },
        sessionDir: dir,
        makeClient: () => {
          throw new Error("client must not be constructed for malformed input");
        },
      });
      expect(outcome.wrote).toBe(false);
      expect(outcome.reason).toBe("malformed-input");
    }
    expect(readState(dir, AGENT, HARNESS_SESSION)?.seq).toBe(0);
  });

  test("missing or unsafe session_id ⇒ zero writes (path-traversal shapes refused)", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    for (const sid of [undefined, "", "../../evil", "a/b", "a b", 42]) {
      const { calls, deps } = captureDeps();
      const outcome = await runCapture(
        JSON.stringify({ hook_event_name: "Stop", session_id: sid, last_assistant_message: "text" }),
        deps,
      );
      expect(outcome.wrote).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  test("no FLAIR_AGENT_ID ⇒ zero writes", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { calls, deps } = captureDeps({ env: {} });
    const outcome = await runCapture(stopInput({ last_assistant_message: "text" }), deps);
    expect(outcome.wrote).toBe(false);
    expect(outcome.reason).toBe("no-agent-id");
    expect(calls).toHaveLength(0);
  });

  test("state file missing (continuity never seeded) ⇒ zero writes", async () => {
    const { calls, deps } = captureDeps();
    const outcome = await runCapture(stopInput({ last_assistant_message: "text" }), deps);
    expect(outcome.wrote).toBe(false);
    expect(outcome.reason).toBe("no-state");
    expect(calls).toHaveLength(0);
  });

  test("#1261 guard 400 on the write path ⇒ one debug warning, clean return, nothing stored client-side", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const attempts: unknown[] = [];
    const { warnings, deps } = captureDeps({
      makeClient: () => ({
        request: async (_m: string, _p: string, body?: unknown) => {
          attempts.push(body);
          throw new Error('PUT /Memory/x -> 400: {"error":"invalid_visibility_for_durability"}');
        },
      }),
    });
    const outcome = await runCapture(postToolUse("Bash", { description: "guarded" }), deps);
    expect(outcome.wrote).toBe(false);
    expect(outcome.reason).toBe("write-failed");
    expect(attempts).toHaveLength(1); // the write was attempted once — no retry storm
    expect(warnings).toHaveLength(1); // exactly one debug-level line
  });

  test("Flair unreachable ⇒ same fail-open shape, never a throw", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { warnings, deps } = captureDeps({
      makeClient: () => ({
        request: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    });
    const outcome = await runCapture(postToolUse("Write", { file_path: "/tmp/x" }), deps);
    expect(outcome.wrote).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  test("a hung Flair is bounded by the 2s-class write timeout — the turn is never held hostage", async () => {
    seedSession(dir, AGENT, HARNESS_SESSION);
    const { warnings, deps } = captureDeps({
      env: { FLAIR_AGENT_ID: AGENT, FLAIR_CONTINUITY_TIMEOUT_MS: "250" },
      makeClient: () => ({
        request: () => new Promise(() => {}), // never resolves
      }),
    });
    const start = Date.now();
    const outcome = await runCapture(postToolUse("Bash", { description: "hang" }), deps);
    const elapsed = Date.now() - start;
    expect(outcome.wrote).toBe(false);
    expect(outcome.reason).toBe("write-failed");
    expect(elapsed).toBeLessThan(2000);
    expect(warnings).toHaveLength(1);
  });
});

// ─── pointer / state files ──────────────────────────────────────────────────

describe("session files: 0600 files in a 0700 dir, IDs only — never journal content", () => {
  test("seedSession creates pointer + state with owner-only modes", () => {
    const state = seedSession(dir, AGENT, HARNESS_SESSION);
    const sub = join(dir); // FLAIR_SESSION_DIR IS the session dir in tests
    expect((statSync(statePath(sub, AGENT, HARNESS_SESSION)).mode & 0o777)).toBe(0o600);
    expect((statSync(pointerPath(sub, AGENT)).mode & 0o777)).toBe(0o600);
    const pointer = readPointer(sub, AGENT);
    expect(pointer?.sessionId).toBe(state.sessionId);
    expect(pointer?.processUUID).toBe(state.processUUID);
    expect(readState(sub, AGENT, HARNESS_SESSION)?.seq).toBe(0);
  });

  test("the session dir minted by seedSession is 0700 when it does not pre-exist", () => {
    const fresh = join(dir, "nested", "session");
    seedSession(fresh, AGENT, HARNESS_SESSION);
    expect((statSync(fresh).mode & 0o777)).toBe(0o700);
  });

  test("bumpSeq without a state file returns null (capture then journals nothing)", () => {
    expect(bumpSeq(dir, AGENT, "never-seeded")).toBeNull();
  });

  test("isSafeFileId refuses separators, whitespace and oversize", () => {
    expect(isSafeFileId("abc-123.DEF_x")).toBe(true);
    expect(isSafeFileId("a/b")).toBe(false);
    expect(isSafeFileId("a\\b")).toBe(false);
    expect(isSafeFileId("a b")).toBe(false);
    expect(isSafeFileId("")).toBe(false);
    expect(isSafeFileId("x".repeat(200))).toBe(false);
    expect(isSafeFileId(undefined)).toBe(false);
  });
});

// ─── resume discovery (S1/S2/S4/S8) ─────────────────────────────────────────

describe("resume: pointer fast path", () => {
  const PRIOR: SessionPointer = { sessionId: "cs-prior", processUUID: "proc-prior", updatedAt: "2026-08-19T09:00:00.000Z" };

  test("reads through the SUPPORTED verb, selects exactly the prior session's tag, returns entries in seq order", async () => {
    // flair#1257 slice 3: the read is `GET /Memory?agentId=<id>` + client-side
    // filtering — the original POST /Memory/search_by_conditions 405s on a
    // real Harper (no REST handler for the ops-API operation), and the
    // fail-open resume masked it as an eternally-empty journal. The selection
    // the old server conditions expressed (own agentId, durability ephemeral,
    // the prior session's tag) is asserted BEHAVIORALLY below: rows violating
    // each condition are present in the response and must not surface.
    const rows = [
      row({ seq: 3, sessionId: "cs-prior", createdAt: "2026-08-19T10:02:00.000Z" }),
      row({ seq: 1, sessionId: "cs-prior", createdAt: "2026-08-19T10:00:00.000Z" }),
      row({ seq: 2, sessionId: "cs-prior", createdAt: "2026-08-19T10:01:00.000Z" }),
      row({ seq: 7, sessionId: "cs-other" }),                                        // different session → excluded
      { ...row({ seq: 8, sessionId: "cs-prior" }), agentId: "someone-else" },        // not ours → excluded
      { ...row({ seq: 9, sessionId: "cs-prior" }), durability: "standard" },         // not the journal tier → excluded
    ];
    const { calls, client } = recordingClient(() => rows);
    const result = await discoverResume(client, AGENT, PRIOR);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe(`/Memory?agentId=${encodeURIComponent(AGENT)}`);

    expect(result.sessionId).toBe("cs-prior");
    expect(result.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("expired rows are excluded even when the server still returns them (reap is async — S4)", async () => {
    const rows = [
      row({ seq: 1, sessionId: "cs-prior", expiresAt: "2026-08-18T00:00:00.000Z" }), // past — reaped-or-not, never surfaced
      row({ seq: 2, sessionId: "cs-prior", expiresAt: "2999-01-01T00:00:00.000Z" }),
    ];
    const { client } = recordingClient(() => rows);
    const result = await discoverResume(client, AGENT, PRIOR, new Date("2026-08-19T12:00:00.000Z"));
    expect(result.entries.map((e) => e.seq)).toEqual([2]);
  });

  test("all rows expired ⇒ zero entries ⇒ null hint (expiry is normal, not data loss)", async () => {
    const rows = [row({ seq: 1, sessionId: "cs-prior", expiresAt: "2026-08-18T00:00:00.000Z" })];
    const { client } = recordingClient(() => rows);
    const result = await discoverResume(client, AGENT, PRIOR, new Date("2026-08-19T12:00:00.000Z"));
    expect(result.entries).toHaveLength(0);
    expect(buildResumeHint(result)).toBeNull();
  });

  test("Flair unreachable ⇒ zero entries, never a throw", async () => {
    const client: ContinuityClient = {
      request: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const result = await discoverResume(client, AGENT, PRIOR);
    expect(result.entries).toHaveLength(0);
    expect(result.sessionId).toBeNull();
  });
});

describe("resume: agentId-wide fallback disambiguated by processUUID (S8)", () => {
  test("two interleaved processes ⇒ ONLY the most recent process's entries, never an interleave", async () => {
    const rows = [
      row({ seq: 1, processUUID: "proc-old", sessionId: "cs-old", createdAt: "2026-08-19T08:00:00.000Z" }),
      row({ seq: 1, processUUID: "proc-new", sessionId: "cs-new", createdAt: "2026-08-19T10:00:00.000Z" }),
      row({ seq: 2, processUUID: "proc-old", sessionId: "cs-old", createdAt: "2026-08-19T08:01:00.000Z" }),
      row({ seq: 2, processUUID: "proc-new", sessionId: "cs-new", createdAt: "2026-08-19T10:01:00.000Z" }),
    ];
    const { calls, client } = recordingClient(() => rows);
    const result = await discoverResume(client, AGENT, null);

    // agentId-wide: the fallback reads the same GET (no per-session tag
    // narrowing) and considered BOTH sessions' rows — proof: it picked
    // cs-new by processUUID recency, which requires having seen cs-old too.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe(`/Memory?agentId=${encodeURIComponent(AGENT)}`);

    expect(result.sessionId).toBe("cs-new");
    expect(result.entries.map((e) => e.processUUID)).toEqual(["proc-new", "proc-new"]);
    expect(result.entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("rows without a processUUID are unattributable and never guessed into a reconstruction", async () => {
    const orphan = row({ seq: 9, sessionId: "cs-x" }) as any;
    delete orphan.meta.processUUID;
    const good = row({ seq: 1, processUUID: "proc-a", sessionId: "cs-a" });
    const { client } = recordingClient(() => [orphan, good]);
    const result = await discoverResume(client, AGENT, null);
    expect(result.entries.map((e) => e.seq)).toEqual([1]);
  });

  test("no rows at all (true cold start, S1) ⇒ zero entries, null hint", async () => {
    const { client } = recordingClient(() => []);
    const result = await discoverResume(client, AGENT, null);
    expect(result.entries).toHaveLength(0);
    expect(buildResumeHint(result)).toBeNull();
  });
});

describe("resume hint: ONE line, count + tag, NEVER journal content (S10)", () => {
  test("hint is a single line naming the count and the search tag", () => {
    const hint = buildResumeHint({
      entries: [
        { id: "1", seq: 1, processUUID: "p", sessionId: "cs-prior", createdAt: "t" },
        { id: "2", seq: 2, processUUID: "p", sessionId: "cs-prior", createdAt: "t" },
      ],
      sessionId: "cs-prior",
    });
    expect(hint).toBeTruthy();
    expect(hint!.includes("\n")).toBe(false);
    expect(hint).toContain("2");
    expect(hint).toContain(continuityTag("cs-prior"));
  });

  test("zero entries ⇒ null (no hint at all — not an empty line, not a warning)", () => {
    expect(buildResumeHint({ entries: [], sessionId: null })).toBeNull();
    expect(buildResumeHint({ entries: [], sessionId: "cs-x" })).toBeNull();
  });
});

// ─── the SessionStart boot plumbing (S1/S7 local half) ─────────────────────
// The runHook end-to-end tests (hint injection, compaction, fail-open through
// the hook's stdout contract) live in
// packages/flair-mcp/test/continuity-resume.test.ts — see the CI-ordering
// note at the top of this file.

describe("prepareContinuityBoot (fs half of the resume path)", () => {
  test("startup: reads the prior pointer BEFORE minting, then rotates and seeds capture state", () => {
    const prior = seedSession(dir, AGENT, "claude-old-sess");
    const boot = prepareContinuityBoot({ session_id: "claude-new-sess", source: "startup" }, AGENT, { FLAIR_SESSION_DIR: dir });
    expect(boot.active).toBe(true);
    expect(boot.priorPointer?.sessionId).toBe(prior.sessionId);
    const rotated = readPointer(dir, AGENT);
    expect(rotated?.sessionId).not.toBe(prior.sessionId);
    expect(readState(dir, AGENT, "claude-new-sess")?.seq).toBe(0);
  });

  test("cold start: no pointer ⇒ priorPointer null (fallback search territory), files seeded", () => {
    const boot = prepareContinuityBoot({ session_id: "claude-new-sess", source: "startup" }, AGENT, { FLAIR_SESSION_DIR: dir });
    expect(boot.active).toBe(true);
    expect(boot.priorPointer).toBeNull();
    expect(readPointer(dir, AGENT)).not.toBeNull();
  });

  test("S7 compaction (either source spelling): fully inert — no pointer read, no rotation, no state touch", () => {
    seedSession(dir, AGENT, "claude-old-sess");
    const pointerBefore = readFileSync(pointerPath(dir, AGENT), "utf-8");
    const stateBefore = readFileSync(statePath(dir, AGENT, "claude-old-sess"), "utf-8");
    for (const input of [
      { session_id: "claude-old-sess", source: "compact" },
      { session_id: "claude-old-sess", how_started: "compact" },
    ]) {
      const boot = prepareContinuityBoot(input, AGENT, { FLAIR_SESSION_DIR: dir });
      expect(boot.active).toBe(false);
      expect(boot.priorPointer).toBeNull();
    }
    expect(readFileSync(pointerPath(dir, AGENT), "utf-8")).toBe(pointerBefore);
    expect(readFileSync(statePath(dir, AGENT, "claude-old-sess"), "utf-8")).toBe(stateBefore);
  });

  test("no session_id ⇒ fully inert (legacy behavior preserved, zero files)", () => {
    const boot = prepareContinuityBoot({ source: "startup" }, AGENT, { FLAIR_SESSION_DIR: dir });
    expect(boot.active).toBe(false);
    expect(existsSync(pointerPath(dir, AGENT))).toBe(false);
  });

  test("unsafe agent id ⇒ inactive, zero files", () => {
    const boot = prepareContinuityBoot({ session_id: "s1", source: "startup" }, "agent/../evil", { FLAIR_SESSION_DIR: dir });
    expect(boot.active).toBe(false);
    expect(existsSync(pointerPath(dir, "agent/../evil"))).toBe(false);
  });
});
