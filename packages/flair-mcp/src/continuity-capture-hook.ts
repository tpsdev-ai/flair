#!/usr/bin/env node

/**
 * Flair continuity-capture hook for Claude Code (flair#1257 slice 2) — the
 * PostToolUse/Stop hook target that auto-journals the agent's working state
 * into the ephemeral Memory tier, so an unseen kill/crash/OOM never loses the
 * cadence. Registered (opt-in) via `flair doctor --fix` / `flair hook install
 * --continuity`; the resume side lives in ./session-start-hook.ts.
 *
 * WHAT IT WRITES — see ./continuity.ts's module doc for the full, binding
 * capture discipline. In one breath: at most ONE ephemeral+private row per
 * fire; mutating tools only; Bash description-only (NEVER the command);
 * Write/Edit/NotebookEdit path-only; Stop = a hard-bounded excerpt of
 * assistant-chosen prose; never the raw hook JSON, never tool results, never
 * an attempt at secret-scrubbing (the bound is the control).
 *
 * NO-OP-ON-ANY-FAILURE GUARANTEE (same posture as session-start-hook.ts):
 * this binary can never block or break the agent's turn. Malformed stdin,
 * missing identity, missing state file, Flair unreachable, a #1261 guard 400,
 * a timeout, an unexpected throw — every one degrades to "journal nothing",
 * at most one debug-level stderr line (the installed command discards
 * stderr), and exit 0. Malformed hook JSON in particular journals NOTHING —
 * no partial extraction that might pull raw tool results into the journal
 * (Sherlock's input-validation tightening).
 *
 * A hard timeout (FLAIR_CONTINUITY_TIMEOUT_MS, default 2s) bounds the journal
 * write so a slow Flair can't make the agent wait on its own diary.
 *
 * CONFIG (env, read identically to the other hook binaries):
 *   FLAIR_AGENT_ID   (required — absent → no-op)
 *   FLAIR_URL        (default http://localhost:19926 via flair-client)
 *   FLAIR_KEY_PATH   (default ~/.flair/keys/<agent>.key via flair-client)
 *   FLAIR_CONTINUITY_TIMEOUT_MS (default 2000; clamped 250..10000)
 *   FLAIR_SESSION_DIR (default ~/.flair/session — test override)
 *   FLAIR_HOOK_PROBE (probe mode: exit immediately, no stdin read, no writes)
 */

import { isProbeMode, readEnvOrUnset, stripInterpolationLiteralsFromEnv } from "./env-guard.js";
import {
  buildJournalRow,
  bumpSeq,
  isSafeFileId,
  planCapture,
  resolveContinuityTimeoutMs,
  resolveSessionDir,
  type CaptureHookInput,
  type ContinuityClient,
} from "./continuity.js";

/** Read all of stdin. Resolves on EOF, with a short fallback for manual runs
 *  where nothing is piped (so it never hangs). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 200).unref?.();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("continuity_write_timeout")), ms);
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

/** Injectable dependencies so the whole flow is unit-testable without a live
 *  Flair daemon or a real ~/.flair (homeOverride discipline). */
export interface CaptureDeps {
  makeClient?: (agentId: string) => ContinuityClient | Promise<ContinuityClient>;
  sessionDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Debug-level warn sink (default: one stderr line). Never stdout. */
  warn?: (message: string) => void;
}

export interface CaptureOutcome {
  /** True only when a journal row was accepted by Flair. */
  wrote: boolean;
  /** Why nothing was written (or "written"). Diagnostic only — the process
   *  exit code is 0 regardless (fail-open). */
  reason:
    | "written"
    | "probe"
    | "malformed-input"
    | "not-capturable"
    | "no-agent-id"
    | "bad-session-id"
    | "no-state"
    | "write-failed";
}

/** Local STRUCTURAL type for the one client surface this factory touches —
 *  declared here, not imported, so the type never depends on flair-client's
 *  emitted declarations existing. The real FlairClient satisfies it (its
 *  constructor takes a config superset; its instances carry request()). */
interface FlairClientConstructor {
  new (config: { agentId: string; url?: string; keyPath?: string }): ContinuityClient;
}

/** LAZY on purpose: @tpsdev-ai/flair-client resolves via its BUILT dist/, and
 *  this module must both LOAD and TYPECHECK without that dist present — the
 *  root `bun test test/unit/` lane AND the strict test-suite typecheck lane
 *  each run before the client is built (see the ordering note in
 *  test/unit/hook-install.test.ts). Tests always inject makeClient, so only
 *  the real binary ever takes this path; the real module boundary is
 *  exercised by the package-lane tests, which build the client first.
 *
 *  `@ts-ignore`, deliberately NOT `@ts-expect-error`: with the dist built the
 *  import DOES resolve, and an expect-error directive would then itself be
 *  the error. ts-ignore is inert in that state — verified locally in BOTH
 *  states (dist present and dist deleted). */
async function defaultClientFactory(agentId: string): Promise<ContinuityClient> {
  // @ts-ignore -- resolvable only once flair-client's dist is built; see doc above
  const mod = await import("@tpsdev-ai/flair-client");
  const FlairClient = mod.FlairClient as unknown as FlairClientConstructor;
  return new FlairClient({
    agentId,
    url: readEnvOrUnset("FLAIR_URL"),
    keyPath: readEnvOrUnset("FLAIR_KEY_PATH"),
  });
}

/**
 * Core capture flow. NEVER throws; never writes to stdout. Returns a
 * diagnostic outcome for tests — the binary ignores it and exits 0.
 */
export async function runCapture(rawInput: string, deps: CaptureDeps = {}): Promise<CaptureOutcome> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((message: string) => console.error(`flair-continuity-capture: ${message}`));
  const now = deps.now ?? (() => new Date());

  // Malformed / non-object hook JSON ⇒ journal NOTHING (Sherlock: no partial
  // extraction — a half-parsed payload must never leak fields into a row).
  let input: CaptureHookInput;
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { wrote: false, reason: "malformed-input" };
    }
    input = parsed as CaptureHookInput;
  } catch {
    return { wrote: false, reason: "malformed-input" };
  }

  // Pure capture decision first — a read-only tool or an empty Stop exits
  // before touching the filesystem or minting a seq.
  const plan = planCapture(input);
  if (!plan) return { wrote: false, reason: "not-capturable" };

  const agentId = env.FLAIR_AGENT_ID;
  if (typeof agentId !== "string" || agentId === "" || !isSafeFileId(agentId)) {
    return { wrote: false, reason: "no-agent-id" };
  }
  const harnessSessionId = input.session_id;
  if (!isSafeFileId(harnessSessionId)) return { wrote: false, reason: "bad-session-id" };

  // Per-process state, seeded by the SessionStart hook. Missing/unreadable ⇒
  // continuity was never seeded for this harness session ⇒ journal nothing.
  const sessionDir = deps.sessionDir ?? resolveSessionDir(env);
  const state = bumpSeq(sessionDir, agentId, harnessSessionId, now());
  if (!state) return { wrote: false, reason: "no-state" };

  const row = buildJournalRow(agentId, state, plan, now());
  const makeClient = deps.makeClient ?? defaultClientFactory;
  try {
    const client = await makeClient(agentId);
    await withTimeout(Promise.resolve(client.request("PUT", `/Memory/${row.id}`, row)), resolveContinuityTimeoutMs(env));
    return { wrote: true, reason: "written" };
  } catch (err: unknown) {
    // Fail-open: Flair unreachable, timeout, or the #1261 guard's 400 — one
    // debug-level line, no retry, never a non-zero exit. The agent's turn is
    // never blocked by its own journal.
    const detail = err instanceof Error ? err.message : String(err);
    warn(`journal write skipped (${detail.slice(0, 200)})`);
    return { wrote: false, reason: "write-failed" };
  }
}

/** Entry point. Reads stdin, captures, exits 0. Prints NOTHING to stdout —
 *  a PostToolUse/Stop hook's stdout is harness-interpreted surface, and this
 *  hook has nothing to say to it. */
async function main(): Promise<void> {
  // Probe mode (flair#1007 pattern): being reached is the whole answer.
  // Exits BEFORE reading stdin and before any filesystem or network touch —
  // a probe must cost nothing and change nothing (especially no seq burn).
  if (isProbeMode()) return;
  try {
    stripInterpolationLiteralsFromEnv();
    await runCapture(await readStdin());
  } catch {
    // Swallow everything — fail-open is the contract.
  }
}

const importMeta = import.meta as ImportMeta & { main?: boolean };
const isMain =
  importMeta.main === true ||
  (typeof process !== "undefined" &&
    process.argv[1] != null &&
    import.meta.url === `file://${process.argv[1]}`);

if (isMain) {
  void main().catch(() => {});
}
