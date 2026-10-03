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
 * This hook can never block or break Claude Code startup. Every failure mode
 * (missing FLAIR_AGENT_ID, malformed stdin, Flair unreachable, auth error, a
 * hung daemon, an unexpected throw) exits 0. Malformed stdin is treated as
 * empty input and can still yield bootstrap context. A failed bootstrap yields
 * a pre-compaction record and/or a continuity resume hint only when their
 * separate lookups find one; otherwise stdout is `{}`. The hook attempts one
 * stderr diagnostic when bootstrap fails (flair#1943). The Codex command retains stderr and the
 * Claude Code command discards it; delivery depends on stderr being writable.
 *
 * A hard timeout (FLAIR_HOOK_TIMEOUT_MS, default 8s) wraps the bootstrap call
 * so a stalled Flair daemon can't hang session startup; on timeout we no-op.
 *
 * That guarantee covers everything from the moment this binary starts running.
 * It cannot cover the case where the binary never runs at all — an `npx`
 * invocation that stops resolving after a Node runtime change (flair#1007) —
 * because the guard would be behind the door it is meant to guard. That half
 * is owned by the command string registered in settings.json; see
 * buildSessionStartHookCommand in the CLI's src/doctor-client.ts.
 *
 * PROBE MODE (flair#1007)
 * ----------------------
 * `flair doctor` needs to answer "does the command registered in settings.json
 * still resolve and execute?" — the check whose absence turned an orphaned
 * shim into an opaque, unattributed error on every session. Setting
 * FLAIR_HOOK_PROBE makes this binary answer that and nothing else: it prints
 * its inert output and exits immediately, before reading stdin, constructing a
 * client, touching the network or writing presence. Being reached at all IS
 * the answer.
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
 *   FLAIR_HOOK_PROBE (unset by default — see PROBE MODE above)
 *
 * USAGE — register with `flair hook install`, or by hand in
 * ~/.claude/settings.json:
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "hooks": [ { "type": "command",
 *           "command": "sh -c 'out=$(FLAIR_AGENT_ID=me npx -y -p @tpsdev-ai/flair-mcp@<version> flair-session-start 2>/dev/null) && printf %s \"$out\" || true'" } ] }
 *       ]
 *     }
 *   }
 */

import { FlairClient } from "@tpsdev-ai/flair-client";
import { basename } from "node:path";
import { deriveActivity, postPresenceSafe, resolvePresenceTimeoutMs, type PresencePoster } from "./presence.js";
import { isProbeMode, readEnvOrUnset, stripInterpolationLiteralsFromEnv } from "./env-guard.js";
import {
  buildResumeHint,
  discoverResume,
  prepareContinuityBoot,
  resolveContinuityTimeoutMs,
  type ContinuityClient,
} from "./continuity.js";
import { fetchPreCompactRecord, formatPreCompactContext, resolvePreCompactLookup } from "./precompact.js";
import { canonicalUrl, DEFAULT_FLAIR_URL } from "./action-recall.js";
import { refreshActionRecallCache, type ActionRecallRefreshClient } from "./action-recall-refresh.js";

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

/** Bootstrap / presence channel. Codex's installer sets FLAIR_HOOK_HARNESS;
 *  unset keeps the historical Claude Code default (flair#1734). */
function resolveHookChannel(): string {
  return process.env.FLAIR_HOOK_HARNESS === "codex" ? "codex" : "claude-code";
}

/** Shape of the SessionStart payload Claude Code writes to stdin (subset).
 *  The "how did this session start" discriminator has appeared as both
 *  `source` and `how_started` across harness doc generations — read either. */
interface SessionStartInput {
  cwd?: string;
  source?: string;
  how_started?: string;
  session_id?: string;
  [key: string]: unknown;
}

// ── continuity resume path (flair#1257 slice 2) ─────────────────────────────
//
// This hook is the SessionStart half of the continuity adapter (the capture
// half is ./continuity-capture-hook.ts; the shared core, the boot plumbing
// (prepareContinuityBoot) and the full design record are in ./continuity.ts).
// On boot it:
//   (a) reads the pointer file ~/.flair/session/<agentId>.current — the
//       prior session, if any (fast path); a missing/unreadable pointer falls
//       back to an agentId-wide ephemeral search inside discoverResume();
//   (b) mints a fresh sessionId + processUUID, seeds the per-harness-session
//       state file the capture hook increments, and rotates the pointer;
//   (c) emits AT MOST one hint line ("N entries from your previous session —
//       search tag …") appended to the bootstrap context. Journal CONTENT is
//       never emitted (agent-pull, scenario S10); zero prior entries ⇒ zero
//       hint. Flair down ⇒ zero hint, boot proceeds (fail-open).
//
// Compaction is NOT a restart: prepareContinuityBoot stays fully inert on a
// compaction-sourced SessionStart — no rotation, no state-file touch, no
// hint (scenario S7 holds by construction).
//
// Pre-compaction record (flair#2069): when the PreCompact hook
// (./precompact-hook.ts) saved a record, this hook shows it FIRST, when the
// marker matches and the GET returns an eligible live row: after a
// compaction, the record this harness session saved; after a restart, the
// one the previous session saved, when the marker still names that session.
// Which record is decided locally, without a request: the marker file
// (./precompact.ts resolvePreCompactLookup: a bounded, asynchronous read) is
// matched against this harness session after a compaction, or against the
// prior continuity pointer after a restart. The record is then fetched with
// one `GET /Memory/<id>`; the lookup and that GET run concurrently with
// bootstrap under the same continuity timeout as the resume hint. No marker,
// or no match ⇒ no record GET (session start's other requests are
// unchanged); any failure ⇒ nothing shown, boot proceeds.
// The record is shown as quoted data between fixed BEGIN/END lines with every
// line prefixed (./precompact.ts formatPreCompactContext).

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
  }): Promise<{ context?: string; scope?: { agentId?: string; isAdmin?: boolean } } | undefined>;
}

/** Injectable pieces for the action-recall refresh (flair#2067 slice 2),
 *  off by default so existing tests and installs are unchanged. */
export interface SessionStartDeps {
  makeRecallClient?: (agentId: string) => ActionRecallRefreshClient;
  now?: number;
  actionRecallRoot?: string;
}

/** Whether the action-recall refresh runs on this SessionStart. Opt-in: the
 *  installer sets FLAIR_ACTION_RECALL=1 on the SessionStart entry. */
export function actionRecallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = readEnvOrUnset("FLAIR_ACTION_RECALL", env);
  return value != null && value !== "" && value !== "0";
}

/** Recall-path client: the SAME identity as the bootstrap client, but with an
 *  EMPTY admin pair so flair-client's FLAIR_ADMIN_USER/PASSWORD Basic fallback
 *  can never turn this read into an admin read. */
function defaultRecallClientFactory(agentId: string): ActionRecallRefreshClient {
  return new FlairClient({
    agentId,
    url: readEnvOrUnset("FLAIR_URL"),
    keyPath: readEnvOrUnset("FLAIR_KEY_PATH"),
    adminUser: "",
    adminPassword: "",
  });
}

/**
 * Probe mode (flair#1007) — see the module doc. The predicate itself moved to
 * ./env-guard.ts when the continuity capture binary (flair#1257) started
 * sharing it; re-exported here unchanged so existing importers keep working.
 */
export { isProbeMode };

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

/** The hook's OWN bootstrap-timer rejection (flair#1943). A dedicated class so
 *  the classifier recognises its own timeout by IDENTITY, never by reading a
 *  message. */
export class BootstrapTimeoutError extends Error {
  constructor() {
    super("bootstrap timeout");
    this.name = "BootstrapTimeoutError";
  }
}

/** Race a promise against a timeout. Rejects with a BootstrapTimeoutError if exceeded. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BootstrapTimeoutError()), ms);
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

export type BootstrapFailureKind = "auth" | "timeout" | "unreachable" | `http-${number}`;

/**
 * flair#1943 — classify a bootstrap failure for the one stderr line. Reads a
 * numeric HTTP status FIRST (`status`, what FlairError carries, then
 * `status_code`, then `statusCode`); when a status exists the message is never
 * consulted. With no status, the ONLY timeout is the hook's own bootstrap
 * timer (a BootstrapTimeoutError) or an error whose name is exactly
 * `TimeoutError`; everything else is `unreachable`. No kind is ever decided
 * from message text. Never reads or includes credentials.
 */
export function classifyBootstrapFailure(err: unknown): BootstrapFailureKind {
  const e = err as
    | { status?: unknown; status_code?: unknown; statusCode?: unknown; name?: unknown }
    | null;
  const status = numericStatus(e);
  if (status !== undefined) return status === 401 || status === 403 ? "auth" : `http-${status}`;
  if (err instanceof BootstrapTimeoutError) return "timeout";
  if (typeof e?.name === "string" && e.name === "TimeoutError") return "timeout";
  return "unreachable";
}

/** The first NUMERIC HTTP status the error carries, checked `status` →
 *  `status_code` → `statusCode` (flair#1943). */
function numericStatus(e: { status?: unknown; status_code?: unknown; statusCode?: unknown } | null): number | undefined {
  for (const key of ["status", "status_code", "statusCode"] as const) {
    const v = e?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

// flair#1943: one no-op 'error' listener per process, so repeated failed
// runs in one process never add listeners (and never trigger Node's
// max-listeners warning on stderr).
let stderrErrorAbsorbed = false;

/** The stderr diagnostic for a failed bootstrap. NAMES the actor, the state and
 *  the remedy; never contains a key, token, password or Authorization value. */
function reportBootstrapFailure(err: unknown): void {
  const kind = classifyBootstrapFailure(err);
  const line = `flair session-start: bootstrap failed (${kind}); this session starts without bootstrap context. Next: run \`flair doctor\`, and check FLAIR_URL and this agent's key.\n`;
  try {
    // Best-effort (flair#1943): a failed stderr write (a closed pipe → EPIPE)
    // must not change stdout or the exit code. The write may throw
    // SYNCHRONOUSLY or surface later as an 'error' event on the stream; absorb
    // both, so the hook still prints its payload and exits 0.
    if (!stderrErrorAbsorbed) {
      process.stderr.on("error", () => {});
      stderrErrorAbsorbed = true;
    }
    process.stderr.write(line);
  } catch {
    // ignore — the diagnostic is best-effort
  }
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
 * A failed bootstrap can still return a pre-compaction record and a
 * continuity resume hint. Without bootstrap context, a pre-compaction record
 * or a resume hint, this returns NOOP_OUTPUT. The entry
 * point catches unexpected exceptions.
 *
 * @param rawInput   the raw stdin string (may be empty / malformed)
 * @param makeClient factory for the bootstrap client (defaults to FlairClient)
 */
export async function runHook(
  rawInput: string,
  makeClient: (agentId: string) => BootstrapClient = defaultClientFactory,
  deps: SessionStartDeps = {},
): Promise<string> {
  // flair#1250: drop any unsubstituted `${...}` interpolation literal from the
  // env before the client is built, so flair-client's own process.env fallback
  // (e.g. FLAIR_URL) can't resurrect the literal and defeat its default. See
  // ./env-guard.ts. Runs here (not just at the call site) because the default
  // client factory below reads process.env directly.
  stripInterpolationLiteralsFromEnv();

  const agentId = readEnvOrUnset("FLAIR_AGENT_ID");
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
  const skipPresence = process.env.FLAIR_HOOK_DELIVERY_PROBE != null
    && process.env.FLAIR_HOOK_DELIVERY_PROBE !== ""
    && process.env.FLAIR_HOOK_DELIVERY_PROBE !== "0";
  const presenceDone: Promise<void> =
    !skipPresence && typeof client.request === "function"
      ? postPresenceSafe(
          client as PresencePoster,
          deriveActivity({ channel: resolveHookChannel() }),
          undefined,
          resolvePresenceTimeoutMs(),
        )
      : Promise.resolve();

  // Continuity resume (flair#1257 slice 2) — the local half (pointer read →
  // mint → rotate → seed capture state) runs unconditionally when applicable;
  // the search half runs CONCURRENTLY with bootstrap below, bounded by its own
  // short timeout, and resolves to null (no hint) on any failure. It needs the
  // signed request() surface; a lightweight bootstrap-only client (tests)
  // skips it entirely.
  const continuity = prepareContinuityBoot(input, agentId);
  const resumeHintDone: Promise<string | null> =
    continuity.active && typeof client.request === "function"
      ? withTimeout(
          discoverResume(client as unknown as ContinuityClient, agentId, continuity.priorPointer).then((result) =>
            buildResumeHint(result),
          ),
          resolveContinuityTimeoutMs(),
        ).catch(() => null)
      : Promise.resolve(null);

  // Pre-compaction record (flair#2069): decided locally, fetched concurrently,
  // the marker read and the fetch both bounded by the same continuity timeout;
  // null (nothing shown) on any failure.
  const precompactDone: Promise<string | null> =
    typeof client.request === "function"
      ? withTimeout(
          (async () => {
            const lookup = await resolvePreCompactLookup(input, agentId, continuity);
            if (!lookup) return null;
            const record = await fetchPreCompactRecord(client as unknown as ContinuityClient, agentId, lookup);
            return record ? formatPreCompactContext(record) : null;
          })(),
          resolveContinuityTimeoutMs(),
        ).catch(() => null)
      : Promise.resolve(null);

  let context = "";
  let bootstrapScope: { agentId?: string; isAdmin?: boolean } | undefined;
  try {
    const res = await withTimeout(
      Promise.resolve(
        client.bootstrap({
          maxTokens: BOOTSTRAP_MAX_TOKENS,
          channel: resolveHookChannel(),
          subjects: project ? [project] : undefined,
        }),
      ),
      resolveTimeoutMs(),
    );
    context = res && res.context ? String(res.context) : "";
    bootstrapScope = res?.scope;
  } catch (err) {
    context = ""; // flair unreachable / auth error / timeout → no bootstrap context
    // flair#1943: keeping stderr open cannot reveal an error never written to
    // it. Write ONE line to STDERR (never stdout — that is the hook payload),
    // so a real failure stays visible instead of being swallowed. A failed
    // bootstrap contributes no bootstrap context; a continuity resume hint may
    // still be returned. The entry point preserves a successful exit.
    reportBootstrapFailure(err);
  }

  const resumeHint = await resumeHintDone;
  const precompactBlock = await precompactDone;
  await presenceDone;

  // Action-recall refresh (flair#2067 slice 2): opt-in, runs AFTER bootstrap
  // with the agent's own non-admin scope, through the recall client whose
  // admin pair is empty. Publication is deadline-checked.
  if (actionRecallEnabled()) {
    const session = typeof input.session_id === "string" ? input.session_id : "";
    const recallUrl = canonicalUrl(readEnvOrUnset("FLAIR_URL") ?? DEFAULT_FLAIR_URL);
    if (bootstrapScope && session && recallUrl) {
      const recallClient = (deps.makeRecallClient ?? defaultRecallClientFactory)(agentId);
      await refreshActionRecallCache(recallClient, {
        agentId,
        url: recallUrl,
        session,
        bootstrapResult: { scope: bootstrapScope },
        now: deps.now,
        root: deps.actionRecallRoot,
      }).catch(() => ({ ok: false }));
    }
  }

  // Combine: the pre-compaction record FIRST (bounded, so the MAX_CHARS cut
  // below can only shorten what follows it), then the bootstrap context, then
  // AT MOST one continuity hint line. Any piece may be absent; all absent ⇒
  // the inert no-op output.
  const pieces: string[] = [];
  if (precompactBlock) pieces.push(precompactBlock);
  if (context.trim()) pieces.push(context);
  if (resumeHint) pieces.push(resumeHint);
  if (pieces.length === 0) return NOOP_OUTPUT;

  let combined = pieces.join("\n\n");
  if (combined.length > MAX_CHARS) combined = combined.slice(0, MAX_CHARS);

  return hookOutput(combined);
}

/** Default client factory — constructs a real FlairClient from FLAIR_* env,
 *  identical to how src/index.ts builds it. */
function defaultClientFactory(agentId: string): BootstrapClient {
  return new FlairClient({
    agentId,
    url: readEnvOrUnset("FLAIR_URL"),
    keyPath: readEnvOrUnset("FLAIR_KEY_PATH"),
  });
}

/** Entry point. Reads stdin, runs the hook, prints the result, exits 0.
 *  Wrapped so that even an unexpected throw degrades to a no-op. */
async function main(): Promise<void> {
  // Probe mode short-circuits BEFORE readStdin() — reaching this line is the
  // entire answer doctor is looking for, and a probe must cost nothing and
  // change nothing (no stdin wait, no client, no bootstrap, no presence).
  if (isProbeMode()) {
    process.stdout.write(NOOP_OUTPUT);
    return;
  }
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
