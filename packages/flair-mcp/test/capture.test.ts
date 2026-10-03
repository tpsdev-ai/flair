/**
 * Capture core + spool (flair#2068) — the pure planning, the local spool and
 * the background flush through Flair's normal write path.
 *
 * These modules did not exist on main, so this file is red there by
 * construction. A fresh temp dir stands in for HOME and FLAIR_CAPTURE_DIR is
 * pinned inside it on every test; the real ~/.flair is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCaptureMemoryRow,
  captureRecordId,
  extractDecision,
  planPostToolUse,
  planStop,
  type PendingError,
} from "../src/capture.ts";
import {
  appendRecord,
  flushStampPath,
  pendingPath,
  readSpool,
  resolveCaptureDir,
  runCapture,
  runCaptureFlush,
  spoolPath,
  CAPTURE_SPOOL_MAX_RECORDS,
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
const env = () => ({ FLAIR_AGENT_ID: "agent-a", FLAIR_CAPTURE_DIR: dir });

function failedBash(command: string, stderr = "Error: boom") {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    cwd: "/repo",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { exit_code: 1, stderr },
  });
}
function okBash(command: string) {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    cwd: "/repo",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { exit_code: 0 },
  });
}
function stop(text: string) {
  return JSON.stringify({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: text });
}

describe("capture planning", () => {
  test("a decision sentence is extracted; a turn with none produces nothing", () => {
    expect(extractDecision("I refactored the parser and ran the tests.")).toBeNull();
    expect(planStop(JSON.parse(stop("I refactored the parser and ran the tests.")) as never, new Date().toISOString())).toBeNull();
    const decision = extractDecision("Decision: we will use host-a instead of host-b for the cache.");
    expect(decision).toContain("host-a instead of host-b");
  });

  test("a failed command records a pending error, and its later fix yields one candidate", () => {
    const t = new Date().toISOString();
    const failed = planPostToolUse(JSON.parse(failedBash("bun test foo")) as never, [], t);
    expect(failed.action).toBe("record-error");
    if (failed.action !== "record-error") throw new Error("expected a pending error");
    const pending: PendingError[] = [failed.error];
    const fixed = planPostToolUse(JSON.parse(okBash("bun test foo")) as never, pending, t);
    expect(fixed.action).toBe("candidate");
    if (fixed.action !== "candidate") throw new Error("expected a candidate");
    expect(fixed.candidate.kind).toBe("error-fix");
    expect(fixed.candidate.content).toContain("Failed: bun test foo");
    expect(fixed.candidate.content).toContain("boom");
    expect(fixed.resolved).toBe(0);
  });

  test("an unrelated successful command does not pair with a pending error", () => {
    const t = new Date().toISOString();
    const failed = planPostToolUse(JSON.parse(failedBash("bun test foo")) as never, [], t);
    if (failed.action !== "record-error") throw new Error("expected a pending error");
    const other = planPostToolUse(JSON.parse(okBash("git status")) as never, [failed.error], t);
    expect(other.action).toBe("none");
  });

  test("a secret-shaped string is redacted before it is ever stored", () => {
    const t = new Date().toISOString();
    const failed = planPostToolUse(JSON.parse(failedBash(`deploy --token ${SECRET}`)) as never, [], t);
    if (failed.action !== "record-error") throw new Error("expected a pending error");
    expect(failed.error.command).not.toContain(SECRET);
    expect(failed.error.command).toContain("[redacted]");
  });
});

describe("capture spool", () => {
  test("one memory from an error-then-fix sequence, flushed once", async () => {
    const kicked: string[] = [];
    const deps = { env: env(), dir, kickFlush: () => kicked.push("x") };
    expect(runCapture(failedBash("bun test foo"), deps).reason).toBe("error-recorded");
    expect(runCapture(okBash("bun test foo"), deps).reason).toBe("appended");
    expect(kicked.length).toBe(1);

    const records = readSpool(dir, "agent-a");
    expect(records.length).toBe(1);

    const puts: string[] = [];
    const client: CaptureClient = { request: async (method, path) => { puts.push(`${method} ${path}`); return {}; } };
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => client });
    expect(result.flushed).toBe(1);
    expect(puts.length).toBe(1);
    expect(puts[0]).toBe(`PUT /Memory/${captureRecordId(records[0]!.dedupKey)}`);
    expect(readSpool(dir, "agent-a").length).toBe(0);
  });

  test("a turn that states a decision produces one memory; a turn with none produces nothing", () => {
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
        dedupKey: `k${i}`,
        provenance: { hook: "Stop", capturedAt: new Date().toISOString() },
      });
    }
    expect(readSpool(dir, "agent-a").length).toBe(CAPTURE_SPOOL_MAX_RECORDS);
  });

  test("a Flair write failure leaves the record staged, bounded", async () => {
    runCapture(stop("Decision: prefer host-a for embeddings."), { env: env(), dir });
    const failing: CaptureClient = { request: async () => { throw new Error("Flair down"); } };
    const result = await runCaptureFlush({ env: env(), dir, makeClient: () => failing });
    expect(result.flushed).toBe(0);
    expect(result.remaining).toBe(1);
    expect(readSpool(dir, "agent-a").length).toBe(1);
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
