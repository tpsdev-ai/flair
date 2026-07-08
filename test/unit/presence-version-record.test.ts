/**
 * presence-version-record.test.ts — Unit tests for the presence-heartbeat
 * record-shape builder behind POST /Presence's version stamping (flair#639).
 *
 * These tests exercise a pure INLINE COPY of buildPresenceRecord()/
 * sanitizeCurrentTask() from resources/Presence.ts — mirrors
 * presence-status-derivation.test.ts's technique for the exact same reason
 * stated there: resources/Presence.ts extends `databases.flair.Presence` at
 * class-definition time (module load), which resolves a live Harper database
 * path and throws immediately outside a running Harper (verified: importing
 * the module directly in a bare `bun run` fails with "Unable to determine
 * database storage path"). Real Harper coverage of the write path — that
 * resolveVersion()/resolveHarperVersion() actually resolve correctly and the
 * live POST persists them — lives in test/integration/presence-api.test.ts.
 *
 * Versions are passed in already-resolved here — this IS "mocking the write
 * path": the two version-resolution functions do real filesystem lookups
 * and are exercised for real (not mocked) in the integration test; here we
 * pin arbitrary values to test the record SHAPE and merge-relevant fields in
 * isolation, with no Harper and no filesystem.
 */

import { describe, test, expect } from "bun:test";

// ─── Inline copies (mirror resources/Presence.ts) ──────────────────────────────

const CURRENT_TASK_MAX_LENGTH = 200;

function sanitizeCurrentTask(task: unknown): string | null {
  if (typeof task !== "string") return null;
  const trimmed = task.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, CURRENT_TASK_MAX_LENGTH);
}

function buildPresenceRecord(
  agentId: string,
  now: number,
  currentTask: unknown,
  activity: string | undefined,
  existingActivity: string | undefined,
  flairVersion: string,
  harperVersion: string | null,
): Record<string, unknown> {
  return {
    agentId,
    lastHeartbeatAt: now,
    currentTask: sanitizeCurrentTask(currentTask),
    activity: activity ?? (existingActivity ?? "idle"),
    flairVersion,
    harperVersion,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

describe("buildPresenceRecord", () => {
  test("stamps both flairVersion and harperVersion onto the record", () => {
    const record = buildPresenceRecord("agent-1", NOW, "reviewing flair#639", "coding", undefined, "0.21.0", "5.1.17");
    expect(record.flairVersion).toBe("0.21.0");
    expect(record.harperVersion).toBe("5.1.17");
  });

  test("harperVersion null passthrough when resolution failed", () => {
    const record = buildPresenceRecord("agent-1", NOW, undefined, "idle", undefined, "0.21.0", null);
    expect(record.harperVersion).toBeNull();
    // flairVersion always resolves to a real string (falls back to "dev"),
    // never null — the two are intentionally different types.
    expect(record.flairVersion).toBe("0.21.0");
  });

  test("core fields (agentId, lastHeartbeatAt) always present", () => {
    const record = buildPresenceRecord("agent-2", NOW, undefined, "idle", undefined, "0.1.0", null);
    expect(record.agentId).toBe("agent-2");
    expect(record.lastHeartbeatAt).toBe(NOW);
  });

  test("activity falls back to existingActivity when not provided", () => {
    const record = buildPresenceRecord("a", NOW, undefined, undefined, "reviewing", "0.1.0", "5.0.0");
    expect(record.activity).toBe("reviewing");
  });

  test("activity falls back to 'idle' when neither activity nor existingActivity is set", () => {
    const record = buildPresenceRecord("a", NOW, undefined, undefined, undefined, "0.1.0", "5.0.0");
    expect(record.activity).toBe("idle");
  });

  test("explicit activity wins over existingActivity", () => {
    const record = buildPresenceRecord("a", NOW, undefined, "planning", "coding", "0.1.0", "5.0.0");
    expect(record.activity).toBe("planning");
  });

  test("currentTask is sanitized (trimmed) the same as before flair#639", () => {
    const record = buildPresenceRecord("a", NOW, "  investigating flair#639  ", "coding", undefined, "0.1.0", "5.0.0");
    expect(record.currentTask).toBe("investigating flair#639");
  });

  test("currentTask capped at 200 chars", () => {
    const long = "x".repeat(500);
    const record = buildPresenceRecord("a", NOW, long, "coding", undefined, "0.1.0", "5.0.0");
    expect((record.currentTask as string).length).toBe(200);
  });

  test("absent currentTask → null (explicit clear, unchanged from pre-#639 behavior)", () => {
    const record = buildPresenceRecord("a", NOW, undefined, "coding", undefined, "0.1.0", "5.0.0");
    expect(record.currentTask).toBeNull();
  });

  test("record has exactly the expected key set (no accidental extra fields)", () => {
    const record = buildPresenceRecord("a", NOW, "task", "coding", undefined, "0.1.0", "5.0.0");
    expect(Object.keys(record).sort()).toEqual(
      ["activity", "agentId", "currentTask", "flairVersion", "harperVersion", "lastHeartbeatAt"].sort(),
    );
  });
});
