#!/usr/bin/env bun
/**
 * Flair action-recall hook for Claude Code (flair#2067 slice 2) — the hot path.
 *
 * Claude Code fires PreToolUse before every tool call. A hook may print
 * `hookSpecificOutput.additionalContext`, which the model reads on the NEXT
 * request (slice 1 established that it can never change the pending command).
 * This binary reads the reader-specific cache of the agent's own lessons
 * (written at session start by ./session-start-hook.ts) and, when the pending
 * Bash command's triggers match, prints the matching lessons as bounded quoted
 * data. It is a signal, never a guardrail.
 *
 * HARD CONTRACT — every line of it is a build contract (flair#2067 slice 2):
 *   - Emits ONLY `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}`.
 *     Never a permission decision, a question, replacement input or blocking
 *     output.
 *   - On ANY error, missing/corrupt/stale/wrong-mode cache, unsupported input
 *     or tool: ZERO stdout and ZERO stderr, exit 0.
 *   - Never executes or echoes the submitted command; never logs an excerpt.
 *
 * NO NETWORK, NO SIGNING, NO SUBPROCESS: this entry point imports no client,
 * reads no key and spawns nothing. It only reads files under the cache root.
 * Stdin and file reads each have a best-effort internal deadline.
 */

import { readStdin, runActionRecall, shouldRunAsMain } from "./action-recall-run.js";

export { runActionRecall };

const importMeta = import.meta as ImportMeta & { main?: boolean };
if (shouldRunAsMain(importMeta, process.argv[1])) {
  void (async () => {
    let output = "";
    try {
      output = await runActionRecall(await readStdin());
    } catch {
      output = "";
    }
    if (output) {
      await new Promise<void>((resolveWrite) => {
        process.stdout.write(output, () => resolveWrite());
      });
    }
    process.exit(0);
  })();
}
