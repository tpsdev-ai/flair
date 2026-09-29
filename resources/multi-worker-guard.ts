/**
 * multi-worker-guard.ts — the S0 multi-worker refusal (flair#2059, slice S0 of #2052).
 *
 * Two per-worker singletons are the reason this exists: the agent-auth replay
 * guard (`nonceSeen` in ed25519-auth.ts) and the federation replay store
 * (federation-nonce-store.ts). Each is an in-memory Map owned by ONE worker
 * thread. Under `server.workerCount > 1` they no longer bound replay, so
 * "a signed request is accepted at most once within its window" is silently
 * removed — and multi-worker is reachable by default (Linux picks several
 * workers when nothing pins the count). The multi-worker readiness work
 * (flair#2052) makes those stores instance-safe. Until it lands, an instance
 * with more than one worker REFUSES TO SERVE rather than run with a security
 * property quietly deleted.
 *
 * This module is the single home for the condition and the state. It reads
 * `server.workerCount` ONCE per process (each worker loads its own copy, so the
 * named boot line is emitted once per worker), decides the state, and answers
 * the questions the rest of the server asks: what does /Health report, and does
 * this request serve or get the named 503.
 *
 * The escape hatch is `FLAIR_MULTI_WORKER_UNSAFE=1`. No flair launch path sets
 * it; it exists for S1's own two-worker tests and for an operator who accepts
 * the risk explicitly. Under it the instance serves, but the boot line is still
 * emitted and /Health stays non-OK, naming the opt-in.
 *
 * With one worker nothing changes: no boot line, and /Health is unchanged.
 */
import { server } from "harper";
import * as harper from "harper";

/** The named refused state. One name for the boot line, /Health and the 503. */
export const MULTI_WORKER_REFUSED_STATE = "multi-worker-unsupported";
/** The error name on every refused-request body (machine-readable). */
export const MULTI_WORKER_ERROR_NAME = "multi_worker_unsupported";
/** The remedy named in the boot line, the 503 body and /Health. */
export const MULTI_WORKER_REMEDY = "THREADS_COUNT=1";
/** The only escape hatch. Exact value "1"; anything else leaves it off. */
export const MULTI_WORKER_UNSAFE_ENV = "FLAIR_MULTI_WORKER_UNSAFE";

/** The three states the guard can be in. */
export type MultiWorkerState = "single-worker" | "refused" | "unsafe-opt-in";

export interface MultiWorkerCondition {
  state: MultiWorkerState;
  /** `server.workerCount` as read once at load, coerced to a positive integer. */
  workerCount: number;
}

/**
 * The /Health `multiWorker` field. Closed schema on purpose — /Health is public
 * and every worker renders this same value, so it carries only enumerated
 * strings and one coarse number: no message, no path, no request-scoped data.
 */
export interface MultiWorkerHealthField {
  state: "refused" | "unsafe-opt-in";
  workerCount: number;
  remedy: string;
}

/** The refusal body. Constant except the coarse worker count. */
export interface MultiWorkerRefusalBody {
  error: string;
  workerCount: number;
  remedy: string;
  detail: string;
}

/**
 * The pure decision, isolated so it is unit-testable without Harper.
 * `workerCount > 1` refuses unless the opt-in is set; anything else serves.
 */
export function decideMultiWorkerState(workerCount: number, optIn: boolean): MultiWorkerState {
  if (!(workerCount > 1)) return "single-worker";
  return optIn ? "unsafe-opt-in" : "refused";
}

/** The escape hatch, read from an env map (defaults to `process.env`). */
export function multiWorkerUnsafeOptIn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MULTI_WORKER_UNSAFE_ENV] === "1";
}

/** /Health's `multiWorker` field, or null on a single worker — the field is
 *  omitted when one worker, so /Health is byte-identical to before this guard. */
export function multiWorkerHealthField(condition: MultiWorkerCondition): MultiWorkerHealthField | null {
  if (condition.state === "single-worker") return null;
  return {
    state: condition.state,
    workerCount: condition.workerCount,
    remedy: condition.state === "refused" ? MULTI_WORKER_REMEDY : `${MULTI_WORKER_UNSAFE_ENV}=1`,
  };
}

/** The named boot line for a condition, or null on a single worker. */
export function multiWorkerBootLine(condition: MultiWorkerCondition): string | null {
  if (condition.state === "single-worker") return null;
  if (condition.state === "refused") {
    return (
      `[multi-worker] refused: server.workerCount=${condition.workerCount}; flair does not serve ` +
      "on more than one Harper worker thread until the multi-worker readiness work lands. " +
      `Set ${MULTI_WORKER_REMEDY} and restart.`
    );
  }
  return (
    `[multi-worker] ${MULTI_WORKER_UNSAFE_ENV}=1 with server.workerCount=${condition.workerCount}: ` +
    "serving with the agent-auth and federation replay guards per worker, so a signed request is " +
    `no longer bound to a single use. Set ${MULTI_WORKER_REMEDY} and unset ${MULTI_WORKER_UNSAFE_ENV}.`
  );
}

/** The body the request guard returns, and the source of /Health's field. */
export function multiWorkerRefusalBody(condition: MultiWorkerCondition): MultiWorkerRefusalBody {
  return {
    error: MULTI_WORKER_ERROR_NAME,
    workerCount: condition.workerCount,
    remedy: MULTI_WORKER_REMEDY,
    detail:
      "flair does not serve on more than one Harper worker thread until the multi-worker readiness work lands.",
  };
}

/** Paths that keep answering in the refused state. /Health renders the refusal
 *  itself, so the request guard steps aside for it (both spellings Harper maps). */
export function isMultiWorkerExemptPath(pathname: string): boolean {
  return pathname === "/Health" || pathname === "/health";
}

/**
 * The named 503 for a refused (or opt-in) request, or null when the request
 * serves. Exempt paths return null so /Health can render the refusal body.
 */
export function multiWorkerRefusalResponse(
  condition: MultiWorkerCondition,
  pathname: string,
): Response | null {
  // Only the refused state blocks a request. A single worker serves, and the
  // explicit opt-in serves too (its /Health stays non-OK via the health field).
  if (condition.state !== "refused" || isMultiWorkerExemptPath(pathname)) return null;
  return new Response(JSON.stringify(multiWorkerRefusalBody(condition)), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

let cached: MultiWorkerCondition | null = null;

/**
 * `server.workerCount`, read once and coerced to a positive integer.
 *
 * Harper defines `workerCount` on the server object on every worker thread (its
 * getter returns the configured thread count there, and 1 on the main worker),
 * so a value that is not a finite number at least 1 is not a serving worker's
 * count. This module treats that as one worker, matching the refusal's `> 1`
 * condition exactly; the guard is inert wherever `server.workerCount` is not a
 * number (for example a bare import outside Harper's worker threads, where
 * there is no worker split for it to protect). The unit lane injects a count.
 */
export function readWorkerCount(): number {
  const raw = (server as { workerCount?: unknown } | undefined)?.workerCount;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

/** The condition, resolved once per process. */
export function resolveMultiWorkerCondition(): MultiWorkerCondition {
  if (cached) return cached;
  const workerCount = readWorkerCount();
  cached = { state: decideMultiWorkerState(workerCount, multiWorkerUnsafeOptIn()), workerCount };
  return cached;
}

/** The condition as read once at load. Every caller shares this one read. */
export function multiWorkerCondition(): MultiWorkerCondition {
  return resolveMultiWorkerCondition();
}

/** Emit the named boot line, when there is one. */
export function announceMultiWorkerCondition(
  condition: MultiWorkerCondition = resolveMultiWorkerCondition(),
): void {
  const line = multiWorkerBootLine(condition);
  if (!line) return;
  const l = (harper as { logger?: { error?: (message: string) => void } }).logger;
  if (typeof l?.error === "function") l.error(line);
  else console.error(line);
}

/** Test seam: forget the memoised condition so a test can re-resolve it. */
export function _resetMultiWorkerGuardForTests(): void {
  cached = null;
}

// Every worker loads this module once, so the named boot line is emitted once
// per worker; every later read answers from the memoised condition.
announceMultiWorkerCondition();
