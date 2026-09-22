/**
 * child-deadline.ts — the shared "a spawned child overran its OWN deadline"
 * message (flair#1799, moved here for flair#1807's class gate).
 *
 * A test that spawns a child with a bounded deadline should report a child that
 * overran it BY NAME, with the child's captured output — not let bun's per-test
 * timer replace it with a bare "timed out" that discards both. Extracted from
 * `packages/flair-mcp/test/session-start-hook-probe.test.ts` so the CLI banner
 * case (`test/unit/cli-test-banner.test.ts`) can use the same shape.
 */

export interface ChildOutcome {
  status: number | null;
  signal: string | null;
  stdout?: string | null;
  stderr?: string | null;
}

/**
 * Describe a child that overran its own deadline, with what it produced.
 *
 * `subject` names the thing spawned (e.g. "hook entry point", "flair CLI");
 * `leg` names which case/leg of it (so a per-test timeout budget can point at
 * the right one).
 */
export function childOverranDeadline(
  subject: string,
  leg: string,
  deadlineMs: number,
  r: ChildOutcome,
): string {
  const outcome =
    r.signal !== null
      ? `did not exit within ${deadlineMs} ms`
      : `exited early with status ${r.status} (signal ${r.signal})`;
  return `${subject} (${leg} leg) ${outcome}; stdout/stderr so far: ${JSON.stringify({
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  })}`;
}
