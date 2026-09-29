/**
 * continuity-precompact.test.ts — flair#2069: the PreCompact continuity
 * record (packages/flair-mcp/src/precompact.ts) and the hook's core flow
 * (runPreCompact in packages/flair-mcp/src/precompact-hook.ts), against the
 * issue's acceptance set: a compaction produces ONE record, it stays within
 * its size bound, and a secret-shaped string in the transcript is redacted in
 * the stored record. Plus: Flair down (one note, never a block), a rerun of
 * the same compaction (still one record), a transcript with no instructions
 * (no instruction section, nothing invented), and every refusal path.
 *
 * LEAK-GUARD PROTOCOL (same as continuity-hook.test.ts): every "absent"
 * assertion has a positive control in the same record, so a hook that stored
 * nothing cannot pass a redaction or filter test.
 *
 * Hermetic: an in-memory fake Flair (rows keyed by id, so a PUT to an existing
 * id updates it the way Memory.put upserts), a per-test temp dir for the
 * session files and the transcript. No network, never the real ~/.flair.
 *
 * NOTE (CI ordering): this file runs in the ROOT `bun test test/unit/` lane,
 * before flair-client's dist/ is built. precompact.ts imports only node
 * builtins and dist-free siblings; precompact-hook.ts imports flair-client
 * LAZILY. The spawned-binary half (real client, real exit code, the signature
 * check, session start showing the record) lives in
 * packages/flair-mcp/test/precompact-hook-entry.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  continuityTag,
  readState,
  seedSession,
  type ContinuityClient,
  type SessionState,
} from "../../packages/flair-mcp/src/continuity.ts";
import {
  PRECOMPACT_DEDUP_WINDOW_MS,
  PRECOMPACT_FLAGGED_NOTE,
  PRECOMPACT_RECORD_MAX_CHARS,
  RECORD_CUT_MARKER,
  REDACTED,
  TRANSCRIPT_TAIL_MAX_LINES,
  boundRecord,
  extractFromTranscript,
  extractInstructions,
  fetchPreCompactRecord,
  formatPreCompactContext,
  precompactMarkerPath,
  readPreCompactMarker,
  readTranscriptTail,
  redactSecrets,
  resolvePreCompactLookup,
  userTurnText,
} from "../../packages/flair-mcp/src/precompact.ts";
import {
  classifyPreCompactFailure,
  PreCompactTimeoutError,
  resolvePreCompactBudgetMs,
  runPreCompact,
  type PreCompactDeps,
} from "../../packages/flair-mcp/src/precompact-hook.ts";

const AGENT = "agent-a";
const HARNESS = "claude-sess-1";

// Secret-shaped fixtures, assembled at run time so no literal token sits in
// the source for a scanner to flag. None of them is a real credential.
const GH_TOKEN = "ghp_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe";
const SK_KEY = "sk-" + "ant-" + "api03-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2";
const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC" + "BKcwggSjAgEAAoIBAQC7";
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;
const PASSWORD_VALUE = "hunter2" + "-Correct-Horse-42";

let dir: string;
let sessionDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-precompact-test-"));
  sessionDir = join(dir, "session");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── transcript fixtures (the JSONL entry shapes the extractor reads) ─────────

let uuid = 0;
const base = () => ({ uuid: `u-${++uuid}`, sessionId: HARNESS, timestamp: "2026-09-29T10:00:00.000Z" });
const userTurn = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base(), type: "user", message: { role: "user", content: text }, ...extra });
const assistantText = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base(), type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const toolUse = (id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base(), type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, ...extra });
const toolResult = (toolUseId: string, content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] }, ...extra });

const TOOL_RESULT_MARKER = "TOOL_RESULT_PAYLOAD_7f3a";
const COMMAND_MARKER = "COMMAND_STRING_9b2c";

/** A realistic tail: instructions, tasks, mutating tools, a secret in a user turn. */
function richTranscript(): string[] {
  return [
    userTurn("Please look at the flaky test in the parser suite."),
    assistantText("Looking at it now."),
    userTurn(`From now on, always run the unit lane before pushing. The deploy token is ${GH_TOKEN} for this week.`),
    userTurn("Never force-push a shared branch. Can you always check CI first?"),
    toolUse("tu-1", "TaskCreate", { subject: "Fix the flaky parser test", description: "d", activeForm: "Fixing" }),
    toolResult("tu-1", "Task #1 created successfully: Fix the flaky parser test", { toolUseResult: { task: { id: "1", subject: "Fix the flaky parser test" } } }),
    toolUse("tu-2", "TaskCreate", { subject: "Write the changelog fragment", description: "d", activeForm: "Writing" }),
    toolResult("tu-2", "Task #2 created successfully", { toolUseResult: { task: { id: "2", subject: "Write the changelog fragment" } } }),
    toolUse("tu-3", "TaskCreate", { subject: "Read the old issue", description: "d", activeForm: "Reading" }),
    toolResult("tu-3", "Task #3 created successfully", { toolUseResult: { task: { id: "3", subject: "Read the old issue" } } }),
    toolUse("tu-4", "TaskUpdate", { taskId: "2", status: "in_progress" }),
    toolUse("tu-5", "TaskUpdate", { taskId: "3", status: "completed" }),
    toolUse("tu-6", "Bash", { command: `curl -H "Authorization: Bearer x" ${COMMAND_MARKER}`, description: "Run the parser tests" }),
    toolResult("tu-6", `${TOOL_RESULT_MARKER} 12 pass 1 fail`),
    toolUse("tu-7", "Read", { file_path: "/repo/src/parser.ts" }),
    toolUse("tu-8", "Edit", { file_path: "/repo/src/parser.ts", old_string: "a", new_string: "b" }),
    assistantText("Fixed the race in the parser; the unit lane is running now."),
  ];
}

function writeTranscript(lines: readonly string[], name = "transcript.jsonl"): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function payload(transcriptPath: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: HARNESS,
    transcript_path: transcriptPath,
    cwd: "/repo",
    hook_event_name: "PreCompact",
    trigger: "auto",
    ...extra,
  });
}

// ── the fake Flair ───────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

class FakeFlair implements ContinuityClient {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly calls: Call[] = [];
  failWith: unknown = null;
  hang = false;

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    if (this.hang) return new Promise<T>(() => {});
    if (this.failWith) throw this.failWith;
    if (method === "PUT" && path.startsWith("/Memory/")) {
      const id = decodeURIComponent(path.slice("/Memory/".length));
      this.rows.set(id, { ...(body as Record<string, unknown>) }); // upsert by id, like Memory.put
      return { id } as T;
    }
    if (method === "GET" && path.startsWith("/Memory/")) {
      const row = this.rows.get(decodeURIComponent(path.slice("/Memory/".length)));
      if (!row) throw Object.assign(new Error("not found"), { status: 404 });
      return row as T;
    }
    return {} as T;
  }

  get puts(): Call[] {
    return this.calls.filter((c) => c.method === "PUT");
  }
}

function deps(fake: FakeFlair, extra: Partial<PreCompactDeps> = {}): PreCompactDeps {
  return {
    env: { FLAIR_AGENT_ID: AGENT, FLAIR_SESSION_DIR: sessionDir },
    sessionDir,
    makeClient: () => fake,
    ...extra,
  };
}

function seed(): SessionState {
  return seedSession(sessionDir, AGENT, HARNESS);
}

function onlyRow(fake: FakeFlair): Record<string, unknown> {
  expect(fake.rows.size).toBe(1);
  return [...fake.rows.values()][0]!;
}

function note(output: string): string {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["systemMessage"]); // never `decision`: that could block compaction
  expect(typeof parsed.systemMessage).toBe("string");
  return parsed.systemMessage as string;
}

// ── acceptance ──────────────────────────────────────────────────────────────

describe("PreCompact record: acceptance (flair#2069)", () => {
  test("a compaction produces ONE record, in the journal row shape, through PUT /Memory/<id>", async () => {
    const state = seed();
    const fake = new FakeFlair();
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake));

    expect(out.reason).toBe("written");
    expect(out.output).toBe(""); // success is silent
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.path).toBe(`/Memory/${encodeURIComponent(out.recordId!)}`);
    const row = onlyRow(fake);
    expect(row.id).toBe(out.recordId);
    expect(row.agentId).toBe(AGENT);
    expect(row.type).toBe("session");
    expect(row.durability).toBe("ephemeral");
    expect(row.visibility).toBe("private");
    expect(row.tags).toEqual([continuityTag(state.sessionId)]);
    expect(row.sessionId).toBe(state.sessionId);
    expect(row.meta).toMatchObject({ hook: "PreCompact", trigger: "auto", seq: 1, processUUID: state.processUUID, sessionId: state.sessionId });
    expect(readState(sessionDir, AGENT, HARNESS)?.seq).toBe(1); // a journal seq was consumed

    const content = String(row.content);
    expect(content.split("\n")[0]).toBe("Pre-compaction continuity record (trigger: auto).");
    expect(content).toContain("Standing instructions (quoted from user turns):");
    expect(content).toContain("- From now on, always run the unit lane before pushing.");
    expect(content).toContain("- Never force-push a shared branch.");
    expect(content).not.toContain("Can you always check CI first?"); // a question is not an instruction
    expect(content).not.toContain("flaky test in the parser suite"); // a plain request is not a standing instruction
    expect(content).toContain("Open tasks:\n- [in_progress] Write the changelog fragment\n- [pending] Fix the flaky parser test");
    expect(content).not.toContain("Read the old issue"); // completed
    expect(content).toContain("In-flight work (most recent last):\n- bash: Run the parser tests\n- edit: /repo/src/parser.ts");
    expect(content).toContain("Last assistant message: Fixed the race in the parser; the unit lane is running now.");
    // Never tool results, never the Bash command, never a read-only tool.
    expect(content).not.toContain(TOOL_RESULT_MARKER);
    expect(content).not.toContain(COMMAND_MARKER);
    expect(content).not.toContain("read:");
  });

  test("the record stays within its size bound on an oversized tail (whole lines kept, then the cut marker)", async () => {
    seed();
    const long = "x".repeat(900);
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(userTurn(`Always keep rule number ${i} in mind ${long}.`));
    for (let i = 0; i < 30; i++) {
      lines.push(toolUse(`c-${i}`, "TaskCreate", { subject: `Task ${i} ${long}` }));
      lines.push(toolResult(`c-${i}`, "created", { toolUseResult: { task: { id: String(i), subject: "s" } } }));
    }
    for (let i = 0; i < 30; i++) lines.push(toolUse(`b-${i}`, "Bash", { command: "true", description: `step ${i} ${long}` }));
    lines.push(assistantText(long.repeat(20)));
    const fake = new FakeFlair();
    const out = await runPreCompact(payload(writeTranscript(lines)), deps(fake));

    expect(out.reason).toBe("written");
    const content = String(onlyRow(fake).content);
    expect(content.length).toBeLessThanOrEqual(PRECOMPACT_RECORD_MAX_CHARS);
    expect(content.endsWith(RECORD_CUT_MARKER)).toBe(true);
    // Positive control: the most valuable section survived the cut.
    expect(content).toContain("Standing instructions (quoted from user turns):");
    expect(content).toMatch(/- Always keep rule number 3\d in mind x+…/);
  });

  test("a secret-shaped string in the transcript is redacted in the stored record (instruction text kept)", async () => {
    seed();
    const lines = [
      userTurn(`From now on, always deploy with ${GH_TOKEN} and never with the old one.`),
      userTurn(`Never paste keys like this one:\n${PEM}\nor password=${PASSWORD_VALUE} again.`),
      userTurn(`Always use the key ${SK_KEY} for the eval runs.`),
      toolUse("t1", "TaskCreate", { subject: `Rotate ${GH_TOKEN}` }),
      toolUse("t2", "Bash", { command: "echo hi", description: `Check token ${GH_TOKEN} scope` }),
      assistantText(`Rotating the key ${SK_KEY} next.`),
    ];
    const fake = new FakeFlair();
    await runPreCompact(payload(writeTranscript(lines)), deps(fake));
    const stored = JSON.stringify(onlyRow(fake));

    for (const secret of [GH_TOKEN, SK_KEY, PEM_BODY, PASSWORD_VALUE, "BEGIN PRIVATE KEY"]) {
      expect(stored).not.toContain(secret);
    }
    const content = String(onlyRow(fake).content);
    // Positive controls: the sentences around each secret were stored.
    expect(content).toContain(`- From now on, always deploy with ${REDACTED} and never with the old one.`);
    expect(content).toContain(`- Always use the key ${REDACTED} for the eval runs.`);
    expect(content).toContain(`[pending] Rotate ${REDACTED}`);
    expect(content).toContain(`bash: Check token ${REDACTED} scope`);
    expect(content).toContain(`Last assistant message: Rotating the key ${REDACTED} next.`);
  });

  test("a rerun for the same compaction (same session and trigger) updates the ONE record", async () => {
    seed();
    const fake = new FakeFlair();
    const path = writeTranscript(richTranscript());
    const t0 = new Date("2026-09-29T10:00:00.000Z");
    const first = await runPreCompact(payload(path), deps(fake, { now: () => t0 }));
    const second = await runPreCompact(payload(path), deps(fake, { now: () => new Date(t0.getTime() + 30_000) }));

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.recordId).toBe(first.recordId);
    expect(fake.puts).toHaveLength(2); // two writes…
    expect(fake.rows.size).toBe(1); // …one record
  });

  test("a different trigger, or the same one after the dedup window, is a new compaction and a new record", async () => {
    seed();
    const fake = new FakeFlair();
    const path = writeTranscript(richTranscript());
    const t0 = new Date("2026-09-29T10:00:00.000Z");
    await runPreCompact(payload(path, { trigger: "auto" }), deps(fake, { now: () => t0 }));
    await runPreCompact(payload(path, { trigger: "manual" }), deps(fake, { now: () => new Date(t0.getTime() + 1000) }));
    expect(fake.rows.size).toBe(2);
    await runPreCompact(
      payload(path, { trigger: "manual" }),
      deps(fake, { now: () => new Date(t0.getTime() + 1000 + PRECOMPACT_DEDUP_WINDOW_MS) }),
    );
    expect(fake.rows.size).toBe(3);
    // The window is measured from the FIRST write of a record, so reruns cannot stretch it.
    const marker = readPreCompactMarker(sessionDir, AGENT);
    expect(marker.kind).toBe("present");
  });

  test("a transcript with no instructions: no instruction section, and nothing invented", async () => {
    seed();
    const lines = [
      userTurn("Please look at the flaky test in the parser suite."),
      toolUse("tu-1", "Write", { file_path: "/repo/notes.md", content: "SECRET_FILE_CONTENT" }),
      assistantText("Wrote the notes file."),
    ];
    const fake = new FakeFlair();
    await runPreCompact(payload(writeTranscript(lines), { trigger: "manual" }), deps(fake));
    expect(String(onlyRow(fake).content)).toBe(
      [
        "Pre-compaction continuity record (trigger: manual).",
        "In-flight work (most recent last):",
        "- write: /repo/notes.md",
        "Last assistant message: Wrote the notes file.",
      ].join("\n"),
    );
  });

  test("a tail with nothing to record writes nothing (no empty record)", async () => {
    seed();
    const fake = new FakeFlair();
    const out = await runPreCompact(payload(writeTranscript([userTurn("Please look at the parser.")])), deps(fake));
    expect(out).toEqual({ output: "", reason: "nothing-to-record" });
    expect(fake.calls).toHaveLength(0);
  });
});

// ── failure paths: one note, never a block ──────────────────────────────────

describe("PreCompact hook: failures print one note and never block compaction", () => {
  test("Flair down: one systemMessage note naming the kind; nothing else", async () => {
    seed();
    const fake = new FakeFlair();
    fake.failWith = new TypeError("fetch failed");
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake));
    expect(out.reason).toBe("write-failed");
    expect(out.output.split("\n")).toHaveLength(1);
    expect(note(out.output)).toBe(
      "Flair: the pre-compaction continuity record was not saved (unreachable); compaction goes ahead. Check Flair with `flair doctor`.",
    );
  });

  test("an auth refusal and an HTTP error are classified by status, never by message", async () => {
    seed();
    const fake = new FakeFlair();
    fake.failWith = Object.assign(new Error("secret-bearing server text"), { status: 401 });
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake));
    expect(note(out.output)).toContain("(auth)");
    expect(out.output).not.toContain("secret-bearing");
    expect(classifyPreCompactFailure({ status: 503 })).toBe("http-503");
    expect(classifyPreCompactFailure(new PreCompactTimeoutError())).toBe("timeout");
    expect(classifyPreCompactFailure(new Error("timeout"))).toBe("unreachable");
  });

  test("a write that never answers ends on the budget with the timeout note", async () => {
    seed();
    const fake = new FakeFlair();
    fake.hang = true;
    const started = Date.now();
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake, { budgetMs: 300, startedAt: started }));
    expect(note(out.output)).toBe(
      "Flair: saving the pre-compaction continuity record did not finish in time (timeout), so it may be missing; compaction goes ahead. Check Flair with `flair doctor`.",
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("no continuity state for the session: one note, no request", async () => {
    const fake = new FakeFlair();
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake));
    expect(out.reason).toBe("no-state");
    expect(note(out.output)).toContain("no continuity state for this session");
    expect(fake.calls).toHaveLength(0);
  });

  test("an unreadable transcript (empty path, missing file, a FIFO) is reported, never treated as empty", async () => {
    seed();
    const fifo = join(dir, "fifo.jsonl");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf-8" });
    expect(made.status).toBe(0); // a missing mkfifo must FAIL, not skip the case
    for (const [path, reason] of [
      ["", "no-path"],
      [join(dir, "missing.jsonl"), "unreadable"],
      [fifo, "not-a-file"],
    ] as const) {
      const fake = new FakeFlair();
      const out = await runPreCompact(payload(path), deps(fake));
      expect(out.reason).toBe("no-transcript");
      expect(note(out.output)).toContain(`the transcript could not be read (${reason})`);
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("an unreadable dedup marker is NOT 'no marker': one note, no request, the file left as it was", async () => {
    seed();
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(precompactMarkerPath(sessionDir, AGENT), "{ not json");
    const fake = new FakeFlair();
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake));
    expect(out.reason).toBe("marker-unreadable");
    expect(note(out.output)).toContain("could not be read (malformed JSON)");
    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(precompactMarkerPath(sessionDir, AGENT), "utf-8")).toBe("{ not json");
  });

  test("a marker path that is not a regular file is refused before it is read (no block on a FIFO), no request", async () => {
    const fake = new FakeFlair();
    seed();
    mkdirSync(precompactMarkerPath(sessionDir, AGENT));
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake));
    expect(out.reason).toBe("marker-unreadable");
    expect(note(out.output)).toContain("could not be read (not a regular file)");
    expect(fake.calls).toHaveLength(0);
  });

  test("silent no-ops: malformed stdin, another event, no agent id, a hostile session id", async () => {
    seed();
    const fake = new FakeFlair();
    const path = writeTranscript(richTranscript());
    expect(await runPreCompact("not json", deps(fake))).toEqual({ output: "", reason: "malformed-input" });
    expect(await runPreCompact("[]", deps(fake))).toEqual({ output: "", reason: "malformed-input" });
    expect(await runPreCompact(payload(path, { hook_event_name: "Stop" }), deps(fake))).toEqual({ output: "", reason: "not-precompact" });
    expect(await runPreCompact(payload(path), deps(fake, { env: { FLAIR_SESSION_DIR: sessionDir } }))).toEqual({
      output: "",
      reason: "no-agent-id",
    });
    expect(await runPreCompact(payload(path, { session_id: "../../etc" }), deps(fake))).toEqual({ output: "", reason: "bad-session-id" });
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(precompactMarkerPath(sessionDir, AGENT))).toBe(false);
  });

  test("the budget env var is clamped to 250..15000 ms, default 5000", () => {
    expect(resolvePreCompactBudgetMs({})).toBe(5000);
    expect(resolvePreCompactBudgetMs({ FLAIR_PRECOMPACT_TIMEOUT_MS: "1200" })).toBe(1200);
    expect(resolvePreCompactBudgetMs({ FLAIR_PRECOMPACT_TIMEOUT_MS: "10" })).toBe(5000);
    expect(resolvePreCompactBudgetMs({ FLAIR_PRECOMPACT_TIMEOUT_MS: "99999" })).toBe(5000);
    expect(resolvePreCompactBudgetMs({ FLAIR_PRECOMPACT_TIMEOUT_MS: "${FLAIR_PRECOMPACT_TIMEOUT_MS}" })).toBe(5000);
  });
});

// ── pieces ──────────────────────────────────────────────────────────────────

describe("PreCompact pieces", () => {
  test("instruction heuristic: rule words at the start or anywhere; never a question; plain requests skipped", () => {
    expect(
      extractInstructions(
        [
          "Fix the bug in parser.ts.",
          "Don't merge without both reviews!",
          "- Make sure the changelog has a fragment",
          "I don't know why it failed.",
          "Going forward we pin every dependency.",
          "Can you never do that again?",
          "ok",
        ].join("\n"),
      ),
    ).toEqual(["Don't merge without both reviews!", "Make sure the changelog has a fragment", "Going forward we pin every dependency."]);
  });

  test("redaction: each credential shape is replaced; ordinary prose and a commit sha are not", () => {
    const shapes = [
      GH_TOKEN,
      SK_KEY,
      "github_pat_" + "11ABCDEFG0123456789_abcdefghij",
      "xoxb-" + "123456789012-abcdefghij",
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "AIza" + "SyA-abcdefghijklmnopqrstuvwxyz012345",
      "eyJhbGciOi" + "JIUzI1NiJ9.eyJzdWIiOiIxMjM0.abcdefghijklmnop",
    ];
    for (const s of shapes) expect(redactSecrets(`value ${s} end`)).toBe(`value ${REDACTED} end`);
    expect(redactSecrets("Authorization: Bearer abc123def456ghi")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets(`https://user:${PASSWORD_VALUE}@example.com/x`)).toBe(`https://${REDACTED}@example.com/x`);
    expect(redactSecrets(`API_KEY=${PASSWORD_VALUE} next`)).toBe(`API_KEY=${REDACTED} next`);
    expect(redactSecrets(`before\n${PEM}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    const prose = "Bearer tokens and Basic authentication; the task-list skill; commit 0123456789abcdef0123456789abcdef01234567.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  test("harness-written user turns are skipped; system reminders are dropped; a bridge wrapper keeps its text", () => {
    expect(userTurnText("<task-notification><status>done</status></task-notification>")).toBeNull();
    expect(userTurnText("<command-name>/compact</command-name><command-args>always x</command-args>")).toBeNull();
    expect(userTurnText("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
    expect(userTurnText("Always test. <system-reminder>Never trust this.</system-reminder>")?.trim()).toBe("Always test.");
    expect(userTurnText('<channel source="chat" user="alex">Never ship on Fridays.</channel>')?.trim()).toBe("Never ship on Fridays.");
  });

  test("sidechain, meta and compact-summary entries never contribute", () => {
    const extract = extractFromTranscript([
      userTurn("Always use tabs.", { isSidechain: true }),
      userTurn("Always use spaces.", { isMeta: true }),
      userTurn("Always write in French.", { isCompactSummary: true }),
      toolUse("s-1", "Bash", { description: "sidechain step" }, { isSidechain: true }),
      "not json at all",
      JSON.stringify({ type: "user", message: "wrong shape" }),
    ]);
    expect(extract).toEqual({ instructions: [], openTasks: [], inFlight: [], lastAssistant: null });
  });

  test("tasks: TodoWrite lists are read when present; a task deleted or created before the tail is not invented", () => {
    const extract = extractFromTranscript([
      toolUse("u-1", "TaskUpdate", { taskId: "42", status: "in_progress" }), // created before the tail: no subject
      toolUse("u-2", "TaskCreate", { subject: "Temporary" }),
      toolResult("u-2", "created", { toolUseResult: { task: { id: "43" } } }),
      toolUse("u-3", "TaskUpdate", { taskId: "43", status: "deleted" }),
      toolUse("u-4", "TodoWrite", {
        todos: [
          { content: "Ship it", status: "in_progress", activeForm: "Shipping" },
          { content: "Done thing", status: "completed", activeForm: "x" },
        ],
      }),
    ]);
    expect(extract.openTasks).toEqual(["[in_progress] Ship it"]);
  });

  test("tail read: only the last bytes and whole lines are read", async () => {
    const lines = Array.from({ length: TRANSCRIPT_TAIL_MAX_LINES + 50 }, (_, i) => `{"n":${i}}`);
    const path = writeTranscript(lines, "long.jsonl");
    const all = await readTranscriptTail(path);
    expect(all.ok && all.lines.length).toBe(TRANSCRIPT_TAIL_MAX_LINES);
    expect(all.ok && all.lines[all.lines.length - 1]).toBe(`{"n":${TRANSCRIPT_TAIL_MAX_LINES + 49}}`);
    const small = await readTranscriptTail(path, 30, 100);
    expect(small.ok).toBe(true);
    for (const line of small.ok ? small.lines : []) expect(line).toMatch(/^\{"n":\d+\}$/); // no fragment of a cut line
  });

  test("boundRecord never exceeds its bound and keeps whole lines", () => {
    const lines = ["header", ...Array.from({ length: 50 }, (_, i) => `- line ${i} ${"y".repeat(30)}`)];
    const bounded = boundRecord(lines, 300);
    expect(bounded.length).toBeLessThanOrEqual(300);
    expect(bounded.split("\n").slice(0, -1).every((l) => lines.includes(l))).toBe(true);
    expect(boundRecord(["a", "b"], 300)).toBe("a\nb");
  });
});

// ── the read side: what session start is pointed at ─────────────────────────

describe("PreCompact surfacing: lookup and fetch (dist-free half)", () => {
  async function writeOneRecord(fake: FakeFlair): Promise<{ recordId: string; state: SessionState }> {
    const state = seed();
    const out = await runPreCompact(payload(writeTranscript(richTranscript())), deps(fake));
    expect(out.reason).toBe("written");
    return { recordId: out.recordId!, state };
  }

  test("after a compaction: the marker for THIS harness session; another session's marker is ignored", async () => {
    const { recordId, state } = await writeOneRecord(new FakeFlair());
    const env = { FLAIR_SESSION_DIR: sessionDir };
    const inactive = { active: false, priorPointer: null };
    expect(resolvePreCompactLookup({ source: "compact", session_id: HARNESS }, AGENT, inactive, env)).toEqual({
      recordId,
      sessionId: state.sessionId,
    });
    expect(resolvePreCompactLookup({ how_started: "compact", session_id: HARNESS }, AGENT, inactive, env)?.recordId).toBe(recordId);
    expect(resolvePreCompactLookup({ source: "compact", session_id: "other" }, AGENT, inactive, env)).toBeNull();
  });

  test("after a restart: only when the prior pointer names the session that wrote it", async () => {
    const { recordId, state } = await writeOneRecord(new FakeFlair());
    const env = { FLAIR_SESSION_DIR: sessionDir };
    const pointer = (sessionId: string) => ({ active: true, priorPointer: { sessionId, processUUID: "p", updatedAt: "" } });
    expect(resolvePreCompactLookup({ source: "startup", session_id: "new" }, AGENT, pointer(state.sessionId), env)?.recordId).toBe(recordId);
    expect(resolvePreCompactLookup({ source: "startup", session_id: "new" }, AGENT, pointer("cs-other"), env)).toBeNull();
    expect(resolvePreCompactLookup({ source: "startup", session_id: "new" }, AGENT, { active: true, priorPointer: null }, env)).toBeNull();
  });

  test("an unreadable marker surfaces nothing", async () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(precompactMarkerPath(sessionDir, AGENT), "{ not json");
    const env = { FLAIR_SESSION_DIR: sessionDir };
    expect(resolvePreCompactLookup({ source: "compact", session_id: HARNESS }, AGENT, { active: false, priorPointer: null }, env)).toBeNull();
  });

  test("fetch accepts only this agent's live PreCompact row with the session tag; a flagged row carries the warning", async () => {
    const fake = new FakeFlair();
    const { recordId, state } = await writeOneRecord(fake);
    const lookup = { recordId, sessionId: state.sessionId };
    const now = new Date();

    const good = await fetchPreCompactRecord(fake, AGENT, lookup, now);
    expect(good?.content).toBe(String(fake.rows.get(recordId)!.content));
    expect(good?.trigger).toBe("auto");
    expect(fake.calls.filter((c) => c.method === "GET").map((c) => c.path)).toEqual([`/Memory/${encodeURIComponent(recordId)}`]);

    const stored = fake.rows.get(recordId)!;
    const variants: Array<Record<string, unknown>> = [
      { ...stored, agentId: "agent-b" },
      { ...stored, durability: "persistent" },
      { ...stored, meta: { ...(stored.meta as object), hook: "Stop" } },
      { ...stored, tags: [continuityTag("cs-other")] },
      { ...stored, expiresAt: "2000-01-01T00:00:00.000Z" },
      { ...stored, content: "" },
    ];
    for (const variant of variants) {
      fake.rows.set(recordId, variant);
      expect(await fetchPreCompactRecord(fake, AGENT, lookup, now)).toBeNull();
    }
    fake.rows.delete(recordId);
    expect(await fetchPreCompactRecord(fake, AGENT, lookup, now)).toBeNull(); // 404

    fake.rows.set(recordId, { ...stored, _safetyFlags: ["instruction_override"] });
    const flagged = await fetchPreCompactRecord(fake, AGENT, lookup, now);
    expect(flagged?.flagged).toBe(true);
    const block = formatPreCompactContext(flagged!);
    expect(block.split("\n")[1]).toBe(PRECOMPACT_FLAGGED_NOTE);
    expect(block.startsWith("Flair continuity record, saved by the PreCompact hook before a context compaction (trigger: auto")).toBe(true);
  });
});
