import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPTURE_BOUND_CHARS,
  CAPTURE_VERSION,
  buildCaptureMemoryRow,
  captureRecordId,
  captureHash,
  extractDecision,
  planPostToolUse,
  planPostToolUseFailure,
  planStop,
  type PendingError,
} from "../src/capture.ts";
import {
  appendRecord,
  flushStampPath,
  flushLockPath,
  lockPath,
  pendingPath,
  readSpool,
  resolveCaptureDir,
  runCapture,
  runCaptureFlush,
  spoolPath,
  CAPTURE_SPOOL_MAX_RECORDS,
  CAPTURE_LOCK_REFRESH_MS,
  type CaptureClient,
} from "../src/capture-spool.ts";

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-capture-home-"));
  dir = join(home, ".flair", "capture");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SECRET = `ghp_${"a".repeat(24)}`;
const BEARER = "Authorization: Bearer abcdefghijklmnopqrstuvwx123";
const env = () => ({ FLAIR_AGENT_ID: "agent-a", FLAIR_CAPTURE_DIR: dir });

for (const [timing, recordCount] of [["between writes", 2], ["after the last write", 1]] as const) {
  test(`lock loss ${timing} returns write-failed and retains the spool`, async () => {
    for (let i = 0; i < recordCount; i++) {
      expect(runCapture(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: `Decision: use host-${i}.` }), {
        env: env(), dir,
      }).reason).toBe("appended");
    }
    let refresh!: () => void;
    let fired = false;
    let signal: AbortSignal | undefined;
    const rows: unknown[] = [];
    const realSetInterval = globalThis.setInterval;
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === CAPTURE_LOCK_REFRESH_MS) {
        refresh = () => { if (typeof callback === "function") callback(...args); };
        return realSetInterval(() => {}, 60_000);
      }
      return realSetInterval(callback, delay, ...args);
    }) as typeof globalThis.setInterval);
    const realAdd = Set.prototype.add;
    const add = spyOn(Set.prototype, "add").mockImplementation(function (this: Set<unknown>, value: unknown) {
      const result = realAdd.call(this, value);
      if (value === 0 && rows.length === 1 && refresh && !fired) {
        fired = true;
        unlinkSync(flushLockPath(dir, "agent-a"));
        refresh();
      }
      return result;
    });
    try {
      const outcome = await runCaptureFlush({ env: env(), dir, makeClient: () => ({
        request: async <T>(_method: string, _path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> => {
          signal = opts?.signal;
          rows.push(body);
          return {} as T;
        },
      }) });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fired).toBe(true);
      expect(rows).toHaveLength(1);
      expect(signal?.aborted).toBe(true);
      expect(outcome).toEqual({ flushed: 1, remaining: recordCount, reason: "write-failed" });
      expect(readSpool(dir, "agent-a")).toHaveLength(recordCount);
      expect(existsSync(lockPath(dir, "agent-a"))).toBe(false);
    } finally {
      add.mockRestore();
      interval.mockRestore();
    }
  });
}

function failedBash(command: string, error = "Exit code 1\nError: boom", extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: "s1",
    transcript_path: "/home/u/.claude/projects/p/s1.jsonl",
    cwd: "/repo",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command, description: "run" },
    tool_use_id: "toolu_01",
    error,
    is_interrupt: false,
    duration_ms: 12,
    ...extra,
  });
}
function okBash(command: string, stderr = "") {
  return JSON.stringify({
    session_id: "s1",
    transcript_path: "/home/u/.claude/projects/p/s1.jsonl",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "run" },
    tool_use_id: "toolu_02",
    tool_response: { stdout: "ok", stderr, interrupted: false, isImage: false },
    duration_ms: 9,
  });
}
function okWrite(filePath: string) {
  return JSON.stringify({
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "fixed" },
    tool_use_id: "toolu_03",
    tool_response: { type: "update", filePath, content: "fixed" },
  });
}
function recordingClient(rows: unknown[]): CaptureClient {
  return { request: async <T>(_method: string, _path: string, body?: unknown): Promise<T> => { rows.push(body); return {} as T; } };
}
function stop(text: string) {
  return JSON.stringify({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: text });
}

describe("capture planning", () => {
  test("a Decision cue is extracted; a routine turn produces nothing", () => {
    expect(extractDecision("I refactored the parser and ran the tests.")).toBeNull();
    expect(planStop(JSON.parse(stop("I refactored the parser and ran the tests.")) as never, new Date().toISOString())).toBeNull();
    const decision = extractDecision("Decision: we will use host-a instead of host-b for the cache.");
    expect(decision).toContain("host-a instead of host-b");
  });

  test("a failed command and a matching success yield one candidate", () => {
    const t = new Date().toISOString();
    const failed = planPostToolUseFailure(JSON.parse(failedBash("bun test foo")) as never, t);
    if (!failed) throw new Error("expected a pending error");
    const pending: PendingError[] = [failed];
    const fixed = planPostToolUse(JSON.parse(okBash("bun test foo")) as never, pending, t);
    expect(fixed.action).toBe("candidate");
    if (fixed.action !== "candidate") throw new Error("expected a candidate");
    expect(fixed.candidate.kind).toBe("error-follow-up");
    expect(fixed.candidate.content).toContain("Failed: bun test foo");
    expect(fixed.candidate.content).toContain("boom");
    expect(fixed.resolved).toBe(0);
  });

  test("different push targets are labeled as a possible matching follow-up", () => {
    const t = new Date().toISOString();
    const failed = planPostToolUseFailure(JSON.parse(failedBash("git push origin main")), t)!;
    const result = planPostToolUse(JSON.parse(okBash("git push origin feature")), [failed], t);
    expect(result.action).toBe("candidate");
    if (result.action !== "candidate") throw new Error("expected candidate");
    expect(result.candidate.content).toContain("Possible matching follow-up: git push origin feature");
    expect(result.candidate.content).not.toContain("fixed");
  });

  test("an interrupted call, a non-Bash failure and an empty error are not pending errors", () => {
    const t = new Date().toISOString();
    expect(planPostToolUseFailure(JSON.parse(failedBash("bun test foo", "Interrupted by user", { is_interrupt: true })) as never, t)).toBeNull();
    expect(planPostToolUseFailure({ ...JSON.parse(failedBash("x")), tool_name: "Write" } as never, t)).toBeNull();
    expect(planPostToolUseFailure(JSON.parse(failedBash("bun test foo", "  ")) as never, t)).toBeNull();
  });

  test("a successful PostToolUse with stderr output is not a failure", () => {
    expect(runCapture(okBash("git push origin main", "To github.com:o/r.git\n   abc..def  main -> main"), { env: env(), dir }).reason).toBe("not-capturable");
    expect(existsSync(pendingPath(dir, "agent-a"))).toBe(false);
  });

  test("git status does not pair with a pending bun test error", () => {
    const t = new Date().toISOString();
    const failed = planPostToolUseFailure(JSON.parse(failedBash("bun test foo")) as never, t);
    if (!failed) throw new Error("expected a pending error");
    const other = planPostToolUse(JSON.parse(okBash("git status")) as never, [failed], t);
    expect(other.action).toBe("none");
  });

  test("the error excerpt keeps the bounded tail", () => {
    const t = new Date().toISOString();
    const long = `${"progress line\n".repeat(200)}fatal: the real cause`;
    const failed = planPostToolUseFailure(JSON.parse(failedBash("bun test foo", long)) as never, t);
    if (!failed) throw new Error("expected a pending error");
    expect(failed.error).toEndWith("fatal: the real cause");
    expect(failed.error.startsWith("…")).toBe(true);
    expect(failed.error.length).toBe(CAPTURE_BOUND_CHARS + 1);
  });

  test("a secret-shaped string is redacted before it is ever stored", () => {
    const t = new Date().toISOString();
    const failed = planPostToolUseFailure(JSON.parse(failedBash(`deploy --token ${SECRET}`)) as never, t);
    if (!failed) throw new Error("expected a pending error");
    expect(failed.command).not.toContain(SECRET);
    expect(failed.command).toContain("[redacted]");
  });
});

describe("capture redaction", () => {
  async function flushRows(): Promise<string> {
    const rows: unknown[] = [];
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => recordingClient(rows) });
    expect(result.flushed).toBe(1);
    return JSON.stringify(rows);
  }

  for (const [label, error] of [
    ["a ghp_ token", `Exit code 1\nremote: invalid credentials for ${SECRET}`],
    ["an Authorization: Bearer line", `Exit code 22\n> GET /api\n> ${BEARER}\n< HTTP/1.1 401`],
  ] as const) {
    test(`redacts ${label} in the failure error`, async () => {
      const secret = label === "a ghp_ token" ? SECRET : "abcdefghijklmnopqrstuvwx123";
      expect(runCapture(failedBash("curl api", error), { env: env(), dir }).reason).toBe("error-recorded");
      const pending = readFileSync(pendingPath(dir, "agent-a"), "utf-8");
      expect(pending).not.toContain(secret);
      expect(pending).toContain("[redacted]");
      expect(runCapture(okBash("curl api"), { env: env(), dir }).reason).toBe("appended");
      const spool = readFileSync(spoolPath(dir, "agent-a"), "utf-8");
      expect(spool).not.toContain(secret);
      expect(spool).toContain("[redacted]");
      const flushed = await flushRows();
      expect(flushed).not.toContain(secret);
      expect(flushed).toContain("[redacted]");
    });
  }

  test("redacts the follow-up file_path", async () => {
    const path = `/repo/${SECRET}/config.json`;
    expect(runCapture(failedBash(`cat ${path}`, `cat: ${path}: No such file or directory`), { env: env(), dir }).reason).toBe("error-recorded");
    const pending = readFileSync(pendingPath(dir, "agent-a"), "utf-8");
    expect(runCapture(okWrite(path), { env: env(), dir }).reason).toBe("appended");
    const spool = readFileSync(spoolPath(dir, "agent-a"), "utf-8");
    expect(spool).toContain("Possible matching follow-up: /repo/[redacted]/config.json");
    for (const text of [pending, spool, await flushRows()]) {
      expect(text).not.toContain(SECRET);
    }
  });

  test("a secret-shaped cwd and session_id are redacted in the spool record and the flushed row", async () => {
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: `sess-${SECRET}`,
      cwd: `/work/${SECRET}/repo`,
      last_assistant_message: "Decision: prefer host-a for embeddings.",
    });
    expect(runCapture(payload, { env: env(), dir }).reason).toBe("appended");
    const spool = readFileSync(spoolPath(dir, "agent-a"), "utf-8");
    expect(spool).not.toContain(SECRET);
    expect(spool).toContain("[redacted]");
    const provenance = (JSON.parse(spool) as { records: Array<{ provenance: { sessionId?: string; cwd?: string } }> }).records[0]!.provenance;
    expect(provenance.sessionId).toContain("[redacted]");
    expect(provenance.cwd).toContain("[redacted]");

    const rows: any[] = [];
    const outcome = await runCaptureFlush({ env: env(), dir, makeClient: () => recordingClient(rows) });
    expect(outcome.flushed).toBe(1);
    expect(rows[0].meta.sessionId).toContain("[redacted]");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  test("the row builder redacts a credential-shaped sessionId it is handed", () => {
    const row = buildCaptureMemoryRow(
      { kind: "decision", content: "x", dedupKey: "abc", provenance: { hook: "Stop", capturedAt: "2026-10-01T00:00:00.000Z", sessionId: `s1-${SECRET}` } },
      "agent-a",
    );
    expect(row.meta.sessionId).toContain("[redacted]");
    expect(row.meta.sessionId).not.toContain(SECRET);
  });
});

describe("capture spool", () => {
  test("one candidate from a failed call and a matching success, flushed once", async () => {
    const kicked: string[] = [];
    const deps = { env: env(), dir, kickFlush: () => kicked.push("x") };
    expect(runCapture(failedBash("bun test foo"), deps).reason).toBe("error-recorded");
    expect(runCapture(okBash("bun test foo"), deps).reason).toBe("appended");
    expect(kicked.length).toBe(1);

    const records = readSpool(dir, "agent-a");
    expect(records.length).toBe(1);

    const puts: string[] = [];
    const client: CaptureClient = { request: async <T>(method: string, path: string): Promise<T> => { puts.push(`${method} ${path}`); return {} as T; } };
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => client });
    expect(result.flushed).toBe(1);
    expect(puts.length).toBe(1);
    expect(puts[0]).toBe(`PUT /Memory/${captureRecordId(records[0]!.dedupKey)}`);
    expect(readSpool(dir, "agent-a").length).toBe(0);
  });

  test("a cue-matching turn stages a candidate; a routine turn does not", () => {
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env: env(), dir }).reason).toBe("appended");
    expect(runCapture(stop("I updated the README and fixed a typo."), { env: env(), dir }).reason).toBe("not-capturable");
    expect(readSpool(dir, "agent-a").length).toBe(1);
  });

  test("capture is deduplicated: the same candidate is staged once", () => {
    const deps = { env: env(), dir };
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), deps).reason).toBe("appended");
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), deps).reason).toBe("deduplicated");
    expect(readSpool(dir, "agent-a").length).toBe(1);
  });

  test("the spool is bounded by record count", () => {
    for (let i = 0; i < CAPTURE_SPOOL_MAX_RECORDS + 5; i++) {
      appendRecord(dir, "agent-a", {
        kind: "decision",
        content: `decision number ${i}`,
        dedupKey: captureHash(`k${i}`),
        provenance: { hook: "Stop", capturedAt: new Date().toISOString() },
      });
    }
    expect(readSpool(dir, "agent-a").length).toBe(CAPTURE_SPOOL_MAX_RECORDS);
  });

  test("malformed spool records ahead of a valid record are excluded from the flush", async () => {
    runCapture(stop("Decision: prefer host-a for embeddings."), { env: env(), dir });
    const valid = readSpool(dir, "agent-a")[0]!;
    const malformed = [
      { ...valid, dedupKey: "../bad" },
      ...[[], {}, { ...valid.provenance, sessionId: {} }, { ...valid.provenance, cwd: 12 },
        { ...valid.provenance, tool: [] }, { ...valid.provenance, hook: "Bogus" },
        { ...valid.provenance, capturedAt: null }].map((provenance) => ({ ...valid, provenance })),
    ];
    writeFileSync(spoolPath(dir, "agent-a"), JSON.stringify({ records: [...malformed, valid] }));
    expect(readSpool(dir, "agent-a")).toEqual([valid]);
    const rows: unknown[] = [];
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => recordingClient(rows) });
    expect(result.flushed).toBe(1);
    expect(result.remaining).toBe(0);
    expect(rows).toHaveLength(1);
  });

  test("a row construction failure leaves that record and attempts the next", async () => {
    runCapture(stop("Decision: prefer host-a for embeddings."), { env: env(), dir });
    runCapture(stop("Decision: prefer host-b for search."), { env: env(), dir });
    let calls = 0;
    const rows: any[] = [];
    const result = await runCaptureFlush({
      env: env(), dir, makeClient: () => recordingClient(rows),
      now: () => { if (calls++ === 0) throw new Error("bad clock"); return new Date(); },
    });
    expect(result.flushed).toBe(1);
    expect(result.remaining).toBe(1);
    expect(rows[0].content).toContain("host-b");
    expect(readSpool(dir, "agent-a")[0]!.content).toContain("host-a");
  });

  test("a failed same-key PUT remains staged after another PUT succeeds", async () => {
    const candidates = ["Error: first failure", "Error: second failure"].map((error) => {
      const pending = planPostToolUseFailure(JSON.parse(failedBash("bun test foo", error)), "2026-10-01T00:00:00.000Z")!;
      const action = planPostToolUse(JSON.parse(okBash("bun test foo")), [pending], "2026-10-01T00:00:00.000Z");
      if (action.action !== "candidate") throw new Error("missing candidate");
      return action.candidate;
    });
    expect(candidates[0]!.dedupKey).toBe(candidates[1]!.dedupKey);
    expect(candidates[0]!.content).not.toBe(candidates[1]!.content);
    mkdirSync(dir, { recursive: true });
    const local = candidates.map((candidate) => ({ v: CAPTURE_VERSION, agentId: "agent-a", ...candidate }));
    const foreign = { ...local[0]!, agentId: "agent-b" };
    const invalid = { ...local[0]!, kind: "unknown" };
    const now = new Date("2026-10-02T00:00:00.000Z");
    for (const failedPosition of [1, 0]) {
      writeFileSync(spoolPath(dir, "agent-a"), JSON.stringify({ records: [foreign, local[0], invalid, local[1]] }));
      const rows: unknown[] = [];
      const result = await runCaptureFlush({ env: env(), dir, now: () => now, makeClient: () => ({
        request: async <T>(_method: string, _path: string, body?: unknown): Promise<T> => {
          rows.push(body);
          if (rows.length - 1 === failedPosition) throw new Error("PUT failed");
          return {} as T;
        },
      }) });
      expect(result).toEqual({ flushed: 1, remaining: 1, reason: "flushed" });
      expect(rows).toEqual(local.map((record) => buildCaptureMemoryRow(record, "agent-a", now)));
      const kept = JSON.parse(readFileSync(spoolPath(dir, "agent-a"), "utf8")).records;
      expect(kept).toEqual(failedPosition === 1 ? [foreign, invalid, local[1]] : [foreign, local[0], invalid]);
      expect(readSpool(dir, "agent-a")).toEqual([local[failedPosition]]);
    }
  });

  test("malformed pending provenance is skipped ahead of a valid pending error", () => {
    runCapture(failedBash("bun test foo"), { env: env(), dir });
    const valid = JSON.parse(readFileSync(pendingPath(dir, "agent-a"), "utf8")).pending[0];
    writeFileSync(pendingPath(dir, "agent-a"), JSON.stringify({ pending: [
      { ...valid, provenance: null }, { ...valid, provenance: { sessionId: {} } }, valid,
    ] }));
    expect(runCapture(okBash("bun test foo"), { env: env(), dir }).reason).toBe("appended");
    expect(readSpool(dir, "agent-a")).toHaveLength(1);
    expect(readSpool(dir, "agent-a")[0]!.provenance.sessionId).toBe("s1");
  });

  test("a spool record for a different agent id is neither flushed nor attributed", async () => {
    const foreign = {
      v: CAPTURE_VERSION,
      agentId: "agent-b",
      kind: "decision",
      content: "Decision: prefer host-b for search.",
      dedupKey: captureHash("foreign"),
      provenance: { hook: "Stop", capturedAt: new Date().toISOString() },
    };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(spoolPath(dir, "agent-a"), JSON.stringify({ v: CAPTURE_VERSION, agentId: "agent-a", records: [foreign] }));
    // Read tolerates the file as it is but keeps only this agent's records.
    expect(readSpool(dir, "agent-a")).toEqual([]);
    const rows: unknown[] = [];
    const outcome = await runCaptureFlush({ env: env(), dir, makeClient: () => recordingClient(rows) });
    expect(outcome.flushed).toBe(0);
    expect(rows).toEqual([]);
    // Left where it is — not re-homed to this agent.
    expect((JSON.parse(readFileSync(spoolPath(dir, "agent-a"), "utf-8")) as { records: unknown[] }).records).toEqual([foreign]);
  });

  test("a Flair write failure leaves the record staged, bounded", async () => {
    runCapture(stop("Decision: prefer host-a for embeddings."), { env: env(), dir });
    const failing: CaptureClient = { request: async () => { throw new Error("Flair down"); } };
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => failing });
    expect(result.flushed).toBe(0);
    expect(result.remaining).toBe(1);
    expect(readSpool(dir, "agent-a").length).toBe(1);
  });

  test("a capture during the flush write is spooled and retained", async () => {
    runCapture(stop("Decision: prefer host-a for embeddings."), { env: env(), dir });
    let attempted = false;
    const client: CaptureClient = {
      request: async <T>(): Promise<T> => {
        if (!attempted) {
          attempted = true;
          expect(runCapture(stop("Decision: we will use host-b for search."), { env: env(), dir }).reason).toBe("appended");
        }
        return {} as T;
      },
    };
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => client });
    expect(result.flushed).toBe(1);
    expect(result.remaining).toBe(1);
    expect(readSpool(dir, "agent-a")).toHaveLength(1);
  });

  test("Stop and failure writes refuse a held per-agent lock", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath(dir, "agent-a"), "held");
    expect(runCapture(stop("Decision: prefer host-a."), { env: env(), dir }).reason).toBe("refused");
    const warnings: string[] = [];
    expect(runCapture(failedBash("bun test foo"), { env: env(), dir, warn: (message) => warnings.push(message) }).reason).toBe("refused");
    // A refused pending error is surfaced, not dropped silently (flair#2395).
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not recorded");
    expect(existsSync(spoolPath(dir, "agent-a"))).toBe(false);
    expect(existsSync(pendingPath(dir, "agent-a"))).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(dir, "agent-a"), old, old);
    expect(runCapture(stop("Decision: prefer host-a."), { env: env(), dir }).reason).toBe("appended");
    expect(existsSync(lockPath(dir, "agent-a"))).toBe(false);
  });

  test("the flush holds a separate lock during writes and releases it", async () => {
    runCapture(stop("Decision: prefer host-a for embeddings."), { env: env(), dir });
    let heldDuringWrite = false;
    const client: CaptureClient = {
      request: async <T>(): Promise<T> => { heldDuringWrite = existsSync(flushLockPath(dir, "agent-a")); return {} as T; },
    };
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => client });
    expect(heldDuringWrite).toBe(true);
    expect(result.flushed).toBe(1);
    expect(result.remaining).toBe(0);
    expect(readSpool(dir, "agent-a")).toHaveLength(0);
    expect(existsSync(lockPath(dir, "agent-a"))).toBe(false);
  });

  test("a malformed payload and a missing agent id capture nothing", () => {
    expect(runCapture("{not json", { env: env(), dir }).reason).toBe("malformed-input");
    expect(runCapture(stop("Decision: one."), { env: { FLAIR_CAPTURE_DIR: dir }, dir }).reason).toBe("no-agent-id");
    expect(existsSync(spoolPath(dir, "agent-a"))).toBe(false);
  });

  test("spool files are private and the agent id is required as a file id", () => {
    runCapture(stop("Decision: prefer host-a."), { env: env(), dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(spoolPath(dir, "agent-a")).mode & 0o777).toBe(0o600);
    expect(runCapture(stop("Decision: prefer host-a."), { env: { FLAIR_AGENT_ID: "../evil", FLAIR_CAPTURE_DIR: dir }, dir }).reason).toBe("no-agent-id");
    // The pending file is also 0600 once written.
    runCapture(failedBash("bun test foo"), { env: env(), dir });
    expect(statSync(pendingPath(dir, "agent-a")).mode & 0o777).toBe(0o600);
  });

  test("a redacted secret never reaches the spool", () => {
    runCapture(stop(`Decision: rotate the token ${SECRET} now.`), { env: env(), dir });
    const raw = readFileSync(spoolPath(dir, "agent-a"), "utf-8");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("[redacted]");
  });

  test("the capture dir honours FLAIR_CAPTURE_DIR and defaults under $HOME", () => {
    expect(resolveCaptureDir({ FLAIR_CAPTURE_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(resolveCaptureDir({ HOME: home })).toBe(join(home, ".flair", "capture"));
  });

  test("the memory row is private, persistent and provenance-stamped", () => {
    const row = buildCaptureMemoryRow(
      { kind: "decision", content: "x", dedupKey: "abc", provenance: { hook: "Stop", capturedAt: "2026-10-01T00:00:00.000Z" } },
      "agent-a",
      new Date("2026-10-02T00:00:00.000Z"),
    );
    expect(row.id).toBe("cap-abc");
    expect(row.visibility).toBe("private");
    expect(row.durability).toBe("persistent");
    expect(row.meta.source).toBe("claude-code-capture");
    expect(row.createdAt).toBe("2026-10-02T00:00:00.000Z");
  });

  test("flush cooldown stamp is written per agent, privately", async () => {
    const { claimFlushSlot } = await import("../src/capture-spool.ts");
    expect(claimFlushSlot(dir, "agent-a", 1000, 500)).toBe(true);
    expect(claimFlushSlot(dir, "agent-a", 1200, 500)).toBe(false);
    expect(claimFlushSlot(dir, "agent-a", 1600, 500)).toBe(true);
    expect(statSync(flushStampPath(dir, "agent-a")).mode & 0o777).toBe(0o600);
  });
});
