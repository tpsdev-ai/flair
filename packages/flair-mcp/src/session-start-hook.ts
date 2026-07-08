#!/usr/bin/env node

/**
 * Flair SessionStart hook for Claude Code — auto-recall on session start.
 *
 * Claude Code fires `SessionStart` hooks when a session begins (startup,
 * resume, clear, compact). A hook of `type: "command"` receives the hook
 * payload as JSON on stdin and may print a JSON object whose
 * `hookSpecificOutput.additionalContext` string is injected into the model's
 * context for that session. This binary uses that channel to inject Flair's
 * `bootstrap` context (soul + relevant memories + predicted context), so a
 * fresh Claude Code session starts already warmed with the agent's memory —
 * no manual "call the bootstrap tool" nudge required.
 *
 * It complements the MCP server (`flair-mcp`): the MCP server gives the agent
 * pull tools (memory_search / memory_store / bootstrap on demand) and push
 * recall, while this hook does a one-shot context push at session start.
 *
 * NO-OP-ON-ANY-FAILURE GUARANTEE
 * ------------------------------
 * This hook can never block or break Claude Code startup. Every failure mode —
 * missing FLAIR_AGENT_ID, malformed stdin, Flair unreachable, auth error, a
 * hung daemon, an unexpected throw — degrades to printing `{}` (an empty,
 * inert hook output) and exiting 0. It never throws, never writes to stderr in
 * a way that surfaces to the user, and never exits non-zero.
 *
 * A hard timeout (FLAIR_HOOK_TIMEOUT_MS, default 8s) wraps the bootstrap call
 * so a stalled Flair daemon can't hang session startup; on timeout we no-op.
 *
 * AUTO-PRESENCE (flair#598)
 * -------------------------
 * A session starting is the clearest "this agent is alive" signal flair-mcp
 * gets, so this hook also fires a best-effort `POST /Presence` heartbeat
 * alongside bootstrap — see ./presence.ts. It runs CONCURRENTLY with the
 * bootstrap call (not serially after it), reuses the SAME signed request
 * path (Ed25519, no new auth mechanism), and is bounded by its own short
 * timeout so it can never add meaningful latency or turn a working bootstrap
 * into a no-op. Manual `flair presence set` keeps working unchanged.
 *
 * CONFIG (env, read identically to the MCP server)
 * ------------------------------------------------
 *   FLAIR_AGENT_ID   (required — absent → no-op)  agent identity
 *   FLAIR_URL        (default http://localhost:19926 via flair-client)
 *   FLAIR_KEY_PATH   (default ~/.flair/keys/<agent>.key via flair-client)
 *   FLAIR_HOOK_TIMEOUT_MS (default 8000; clamped 500..30000)
 *   FLAIR_PRESENCE_TIMEOUT_MS (default 3000; clamped 500..10000 — see ./presence.ts)
 *
 * USAGE — register in ~/.claude/settings.json:
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "hooks": [ { "type": "command",
 *           "command": "FLAIR_AGENT_ID=me npx -y @tpsdev-ai/flair-mcp flair-session-start" } ] }
 *       ]
 *     }
 *   }
 */

import { FlairClient } from "@tpsdev-ai/flair-client";
import { basename } from "node:path";
import { deriveActivity, postPresenceSafe, resolvePresenceTimeoutMs, type PresencePoster } from "./presence.js";

/** Claude Code SessionStart additionalContext hard limit (chars). */
const MAX_CHARS = 10_000;

/** Token budget for the bootstrap call — matches the proven prototype. */
const BOOTSTRAP_MAX_TOKENS = 2000;

/** Default hard timeout on the bootstrap call (ms). */
const DEFAULT_TIMEOUT_MS = 8000;
const TIMEOUT_FLOOR_MS = 500;
const TIMEOUT_CEILING_MS = 30_000;

/** Empty, inert hook output. Printing this is always a safe no-op. */
const NOOP_OUTPUT = "{}";

/** Shape of the SessionStart payload Claude Code writes to stdin (subset). */
interface SessionStartInput {
  cwd?: string;
  source?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** Minimal surface of FlairClient this hook depends on (eases testing).
 *  `request` is optional and structurally matches PresencePoster (presence.ts)
 *  — the real FlairClient always has it. When present, this hook also fires a
 *  best-effort presence heartbeat (flair#598) alongside bootstrap; when
 *  absent (e.g. a lightweight test stub that only implements bootstrap()),
 *  the heartbeat is silently skipped — no behavior change for those tests. */
interface BootstrapClient extends Partial<PresencePoster> {
  bootstrap(opts: {
    maxTokens?: number;
    channel?: string;
    subjects?: string[];
  }): Promise<{ context?: string } | undefined>;
}

/** Resolve the bootstrap timeout from env, clamped to a sane range. */
function resolveTimeoutMs(): number {
  const raw = process.env.FLAIR_HOOK_TIMEOUT_MS;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= TIMEOUT_FLOOR_MS && parsed <= TIMEOUT_CEILING_MS
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

/** Read all of stdin as a string. Resolves on EOF, with a short fallback for
 *  interactive/manual runs where no stdin is piped (so it never hangs). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    // Manual-run fallback: if nothing is piped, don't block forever.
    setTimeout(() => resolve(data), 200).unref?.();
  });
}

/** Race a promise against a timeout. Rejects with a timeout error if exceeded. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bootstrap_timeout")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Build the SessionStart hook output JSON from a context string. */
function hookOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

/**
 * Core hook logic, with injectable dependencies so it can be unit-tested
 * without a live Flair daemon. Returns the exact string to print to stdout.
 * NEVER throws — every failure path returns NOOP_OUTPUT.
 *
 * @param rawInput   the raw stdin string (may be empty / malformed)
 * @param makeClient factory for the bootstrap client (defaults to FlairClient)
 */
export async function runHook(
  rawInput: string,
  makeClient: (agentId: string) => BootstrapClient = defaultClientFactory,
): Promise<string> {
  const agentId = process.env.FLAIR_AGENT_ID;
  if (!agentId) return NOOP_OUTPUT; // no identity → no-op, never break the session

  let input: SessionStartInput = {};
  try {
    input = (JSON.parse(rawInput || "{}") as SessionStartInput) ?? {};
  } catch {
    input = {}; // tolerate malformed stdin
  }

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const project = basename(cwd) || undefined;

  const client = makeClient(agentId);

  // Auto-presence (flair#598): a session starting is the clearest "this
  // agent is alive" signal available. Fired CONCURRENTLY with the bootstrap
  // call below (not serially after it) and bounded by its own short timeout
  // (resolvePresenceTimeoutMs(), default 3s) — postPresenceSafe() never
  // throws (see presence.ts's fail-open contract), so this can never turn a
  // working bootstrap into a no-op, and awaiting `presenceDone` below can
  // never add meaningful latency beyond what bootstrap already budgets
  // (resolveTimeoutMs(), default 8s). No currentTask here: the SessionStart
  // payload doesn't carry a task description (unlike the MCP `bootstrap`
  // tool call — see index.ts), so this only ever sets `activity`, leaving
  // currentTask exactly whatever it already was.
  const presenceDone: Promise<void> =
    typeof client.request === "function"
      ? postPresenceSafe(
          client as PresencePoster,
          deriveActivity({ channel: "claude-code" }),
          undefined,
          resolvePresenceTimeoutMs(),
        )
      : Promise.resolve();

  let context = "";
  try {
    const res = await withTimeout(
      Promise.resolve(
        client.bootstrap({
          maxTokens: BOOTSTRAP_MAX_TOKENS,
          channel: "claude-code",
          subjects: project ? [project] : undefined,
        }),
      ),
      resolveTimeoutMs(),
    );
    context = res && res.context ? String(res.context) : "";
  } catch {
    await presenceDone;
    return NOOP_OUTPUT; // flair unreachable / auth error / timeout → no-op
  }

  await presenceDone;

  if (!context.trim()) return NOOP_OUTPUT;
  if (context.length > MAX_CHARS) context = context.slice(0, MAX_CHARS);

  return hookOutput(context);
}

/** Default client factory — constructs a real FlairClient from FLAIR_* env,
 *  identical to how src/index.ts builds it. */
function defaultClientFactory(agentId: string): BootstrapClient {
  return new FlairClient({
    agentId,
    url: process.env.FLAIR_URL,
    keyPath: process.env.FLAIR_KEY_PATH,
  });
}

/** Entry point. Reads stdin, runs the hook, prints the result, exits 0.
 *  Wrapped so that even an unexpected throw degrades to a no-op. */
async function main(): Promise<void> {
  let output = NOOP_OUTPUT;
  try {
    output = await runHook(await readStdin());
  } catch {
    output = NOOP_OUTPUT;
  }
  process.stdout.write(output);
}

// Only run when executed as a script, not when imported by tests.
// import.meta.main is set by Bun and Node 22.x; fall back to an argv check
// for runtimes that don't populate it.
const importMeta = import.meta as ImportMeta & { main?: boolean };
const isMain =
  importMeta.main === true ||
  (typeof process !== "undefined" &&
    process.argv[1] != null &&
    import.meta.url === `file://${process.argv[1]}`);

if (isMain) {
  // .catch is belt-and-suspenders; main() already swallows everything.
  void main().catch(() => process.stdout.write(NOOP_OUTPUT));
}
