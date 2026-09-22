/**
 * child-deadline.ts — the shared "a spawned child overran its OWN deadline"
 * message (flair#1799, moved here for flair#1807's class gate).
 *
 * A test that spawns a child with a bounded deadline should report a child that
 * overran it BY NAME, with the child's captured output — not let bun's per-test
 * timer replace it with a bare "timed out" that discards both. Extracted from
 * `packages/flair-mcp/test/session-start-hook-probe.test.ts` so the CLI banner
 * case (`test/unit/cli-test-banner.test.ts`) can use the same shape.
 *
 * flair#1807 carry-over: naming a signal as an overrun is only TRUE when that
 * signal is the one the spawn's own `timeout` sends. A SIGKILL from the OOM
 * killer, or a SIGTERM from anywhere but the deadline timer, is a different
 * event and used to be reported as "did not exit within <deadline> ms" — a
 * claim about the child that the child's death did not support. The caller can
 * now pass what it measured (`elapsedMs`) and what the deadline timer sends
 * (`timeoutSignal`, SIGTERM by default); the message says "overran its N ms
 * deadline" only on that match, and names the signal otherwise. Callers that
 * pass no timing keep a signal-naming message, since without a measurement an
 * overrun cannot be asserted at all.
 */

export interface ChildOutcome {
  status: number | null;
  signal: string | null;
  stdout?: string | null;
  stderr?: string | null;
  /** Wall-clock time the caller measured for the child, when it measured one. */
  elapsedMs?: number;
  /** The signal the spawn's own `timeout` sends. Defaults to SIGTERM. */
  timeoutSignal?: string;
}

/**
 * Name a spawned CLI run for the message's `leg` slot from its own argv:
 * ["orgevent", "publish", "--kind", …] -> "orgevent publish"; ["init", …] ->
 * "init". The spawned COMMAND is what a reader needs to find the case, and it
 * cannot drift out of sync with the spawn the way a hand-copied label can.
 */
export function cliLeg(args: readonly string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    words.push(arg);
    if (words.length === 2) break;
  }
  return words.join(" ") || "cli";
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
  const timeoutSignal = r.timeoutSignal ?? "SIGTERM";
  let outcome: string;
  if (r.signal === null) {
    outcome = `exited with status ${r.status} and no signal, so it did not overrun its ${deadlineMs} ms deadline`;
  } else if (r.elapsedMs !== undefined && r.signal === timeoutSignal && r.elapsedMs >= deadlineMs) {
    outcome = `overran its ${deadlineMs} ms deadline (killed by ${r.signal} after ${r.elapsedMs} ms)`;
  } else if (r.elapsedMs !== undefined) {
    outcome = `killed by ${r.signal} after ${r.elapsedMs} ms, before the ${deadlineMs} ms deadline was reached`;
  } else {
    outcome = `killed by ${r.signal} (no elapsed time was measured against the ${deadlineMs} ms deadline)`;
  }
  return `${subject} (${leg} leg) ${outcome}; stdout/stderr so far: ${JSON.stringify({
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  })}`;
}
