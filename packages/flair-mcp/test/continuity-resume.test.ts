/**
 * continuity-resume.test.ts — flair#1257 slice 2: the SessionStart hook's
 * resume path end-to-end through runHook's stdout contract (S1 cold start,
 * S2 resume hint, S7 compaction, S10 fail-open / agent-pull).
 *
 * Lives in THIS package's lane (which builds @tpsdev-ai/flair-client first)
 * because runHook's module statically imports the client by its built dist —
 * the root test/unit lane runs before that build exists. The dist-free half
 * of the continuity suite (capture discipline, resume discovery, boot
 * plumbing, leak-guards) is test/unit/continuity-hook.test.ts.
 *
 * Hermetic: injected clients, per-test temp FLAIR_SESSION_DIR — no test ever
 * touches the real ~/.flair (homeOverride discipline).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHook } from "../src/session-start-hook.ts";
import {
  continuityTag,
  pointerPath,
  readPointer,
  readState,
  seedSession,
} from "../src/continuity.ts";

const AGENT = "agent-a";
const NOOP = "{}";

const ORIGINAL_ENV = {
  FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID,
  FLAIR_SESSION_DIR: process.env.FLAIR_SESSION_DIR,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-continuity-resume-test-"));
  process.env.FLAIR_SESSION_DIR = dir;
  process.env.FLAIR_AGENT_ID = AGENT;
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function journalRow(opts: { seq: number; sessionId: string; processUUID: string; content?: string }) {
  return {
    id: `${AGENT}-row-${opts.seq}`,
    agentId: AGENT,
    content: opts.content ?? "bash: something",
    durability: "ephemeral",
    visibility: "private",
    tags: [continuityTag(opts.sessionId)],
    sessionId: opts.sessionId,
    createdAt: "2026-08-19T10:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    meta: { seq: opts.seq, processUUID: opts.processUUID, sessionId: opts.sessionId },
  };
}

function startInput(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ cwd: "/tmp/proj", source: "startup", session_id: "claude-new-sess", ...extra });
}

describe("session-start resume path (runHook end-to-end)", () => {
  const JOURNAL_MARKER = "JOURNAL_CONTENT_MARKER_5a1c";

  test("S1 cold start: pointer + state seeded, NO hint, boot proceeds clean", async () => {
    const out = await runHook(startInput(), () => ({
      bootstrap: async () => ({ context: "## Identity" }),
      request: async () => [],
    }));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("## Identity");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("Continuity:");

    // Local half ran: pointer + state exist, capture is ready.
    expect(readPointer(dir, AGENT)).not.toBeNull();
    expect(readState(dir, AGENT, "claude-new-sess")?.seq).toBe(0);
  });

  test("S2 resume: prior pointer ⇒ ONE hint line with count + old tag; journal CONTENT never injected; pointer rotates", async () => {
    const prior = seedSession(dir, AGENT, "claude-old-sess"); // simulates the dead process's boot
    const priorRows = [
      journalRow({ seq: 1, sessionId: prior.sessionId, processUUID: prior.processUUID, content: `intent one ${JOURNAL_MARKER}` }),
      journalRow({ seq: 2, sessionId: prior.sessionId, processUUID: prior.processUUID, content: `intent two ${JOURNAL_MARKER}` }),
    ];
    const out = await runHook(startInput(), () => ({
      bootstrap: async () => ({ context: "## Identity" }),
      request: async (_m: string, p: string) => (p.startsWith("/Memory?agentId=") ? priorRows : {}),
    }));
    const context: string = JSON.parse(out).hookSpecificOutput.additionalContext;
    const hintLines = context.split("\n").filter((l) => l.includes("Continuity:"));
    expect(hintLines).toHaveLength(1); // at most ONE hint line
    expect(hintLines[0]).toContain("2");
    expect(hintLines[0]).toContain(continuityTag(prior.sessionId));
    expect(context).not.toContain(JOURNAL_MARKER); // agent-pull: content NEVER injected

    const rotated = readPointer(dir, AGENT);
    expect(rotated?.sessionId).not.toBe(prior.sessionId); // minted + rotated
  });

  test("S7 compaction: no search, no hint, no rotation — the journal never fragments", async () => {
    const seeded = seedSession(dir, AGENT, "claude-old-sess");
    for (const sourceField of [{ source: "compact" }, { how_started: "compact" }]) {
      const searches: string[] = [];
      const out = await runHook(
        JSON.stringify({ cwd: "/tmp/proj", session_id: "claude-old-sess", ...sourceField }),
        () => ({
          bootstrap: async () => ({ context: "ctx" }),
          request: async (_m: string, p: string) => {
            searches.push(p);
            return [journalRow({ seq: 1, sessionId: seeded.sessionId, processUUID: seeded.processUUID })];
          },
        }),
      );
      expect(searches.filter((p) => p.startsWith("/Memory?agentId="))).toHaveLength(0);
      expect(JSON.parse(out).hookSpecificOutput.additionalContext).not.toContain("Continuity:");
    }
    expect(readPointer(dir, AGENT)?.sessionId).toBe(seeded.sessionId); // never rotated
    expect(readState(dir, AGENT, "claude-old-sess")?.sessionId).toBe(seeded.sessionId);
  });

  test("S10 fail-open: Flair fully down ⇒ no hint, inert output, boot proceeds — capture state still seeded locally", async () => {
    seedSession(dir, AGENT, "claude-old-sess"); // a prior session exists…
    const out = await runHook(startInput(), () => ({
      bootstrap: async () => {
        throw new TypeError("fetch failed");
      },
      request: async () => {
        throw new TypeError("fetch failed");
      },
    }));
    expect(out).toBe(NOOP); // …but with Flair down there is NO hint and no error wall
    expect(readState(dir, AGENT, "claude-new-sess")).not.toBeNull(); // local half still ran
  });

  test("zero prior entries ⇒ output contains no hint text at all (assert absence, not merely no error)", async () => {
    seedSession(dir, AGENT, "claude-old-sess"); // pointer exists, journal empty
    const out = await runHook(startInput(), () => ({
      bootstrap: async () => ({ context: "## Identity" }),
      request: async () => [],
    }));
    const context: string = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(context).toBe("## Identity");
    expect(context).not.toContain("Continuity:");
  });

  test("a hint can carry the output alone (bootstrap empty but journal present)", async () => {
    const prior = seedSession(dir, AGENT, "claude-old-sess");
    const out = await runHook(startInput(), () => ({
      bootstrap: async () => ({ context: "" }),
      request: async (_m: string, p: string) =>
        p.startsWith("/Memory?agentId=")
          ? [journalRow({ seq: 1, sessionId: prior.sessionId, processUUID: prior.processUUID })]
          : {},
    }));
    const context: string = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(context).toContain("Continuity:");
    expect(context).toContain(continuityTag(prior.sessionId));
  });

  test("no session_id in the payload ⇒ continuity fully inert (legacy behavior preserved, no files)", async () => {
    const out = await runHook(JSON.stringify({ cwd: "/tmp/proj", source: "startup" }), () => ({
      bootstrap: async () => ({ context: "ctx" }),
      request: async () => [],
    }));
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("ctx");
    expect(existsSync(pointerPath(dir, AGENT))).toBe(false);
  });

  test("a bootstrap-only client (no request surface) skips the resume search but still seeds capture state", async () => {
    const out = await runHook(startInput(), () => ({
      bootstrap: async () => ({ context: "ctx" }),
    }));
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("ctx");
    expect(readState(dir, AGENT, "claude-new-sess")).not.toBeNull();
  });

  test("a hanging resume search is bounded by its own timeout and degrades to no-hint (never blocks boot)", async () => {
    process.env.FLAIR_CONTINUITY_TIMEOUT_MS = "250";
    try {
      seedSession(dir, AGENT, "claude-old-sess");
      const start = Date.now();
      const out = await runHook(startInput(), () => ({
        bootstrap: async () => ({ context: "ctx" }),
        request: (_m: string, p: string) =>
          p.startsWith("/Memory?agentId=") ? new Promise(() => {}) : Promise.resolve({}),
      }));
      const elapsed = Date.now() - start;
      const context: string = JSON.parse(out).hookSpecificOutput.additionalContext;
      expect(context).toBe("ctx");
      expect(context).not.toContain("Continuity:");
      expect(elapsed).toBeLessThan(3000);
    } finally {
      delete process.env.FLAIR_CONTINUITY_TIMEOUT_MS;
    }
  });
});
