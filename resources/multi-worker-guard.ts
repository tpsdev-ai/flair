/**
 * multi-worker-guard.ts — the S0 multi-worker refusal (flair#2059, slice S0 of #2052).
 *
 * Flair runs one Harper worker thread by default. More than one is not yet
 * supported: the multi-worker readiness audit (flair#2052) is not complete — a
 * per-worker embedding engine and per-worker BM25 index copies today, with the
 * in-process caches and rate limiters not yet enumerated — and the XAA token
 * path keeps its own `jti` single-use record (resources/XAA.ts), a get-then-put
 * that two workers can both pass, until flair#2073 routes it through the shared
 * atomic check-and-record. Until that work lands, an instance with more than one
 * worker REFUSES TO SERVE rather than run with those properties silently
 * removed. Linux can select several workers when nothing pins the count, so the
 * state is reachable by default, not only on purpose.
 *
 * This module is the single home for the condition and the state. It reads the
 * worker count ONCE per worker module instance (each worker loads its own copy,
 * so the named boot line is emitted once per worker instance), decides the
 * state, and answers the questions the rest of the server asks: what does
 * /Health report, and does this request serve or get the named 503. The count is
 * `server.workerCount`, Harper's per-thread value; where that is not a positive
 * integer (on the main thread alongside worker threads it is `undefined`), the
 * count falls back to Harper's effective configured count,
 * `server.config.threads.count`. A count that is not a positive integer on
 * either path — including a getter that throws — is UNKNOWN, which is refused,
 * never read as one worker.
 *
 * The refused state is enforced before dispatch. This module registers ONE
 * named http entry, runFirst and ordered ahead of the default REST middleware
 * (auth-middleware.ts, which orders itself after this entry): so the refusal
 * lands before the method allowlist, before Harper's `authentication` and
 * before any flair handler on the default chain. A urlPath mount (for example
 * `/mcp`) gets its OWN dispatch chain, so flair's mounts declare
 * `after: MULTI_WORKER_GUARD_HTTP_NAME` to pull this entry into their chains,
 * and oauth-wellknown.ts registers this same guard function as a runFirst mount
 * at the @harperfast/oauth plugin's well-known paths, whose mounts carry no
 * ordering constraint of their own.
 *
 * The escape hatch is `FLAIR_MULTI_WORKER_UNSAFE=1`. No flair launch path sets
 * it; it exists for the readiness work's own two-worker tests and for an
 * operator who accepts the risk explicitly. Under it requests serve; the boot
 * line is still emitted and /Health stays non-OK, naming the opt-in.
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
/** This module's http-entry name, so flair's mounts order it ahead of themselves. */
export const MULTI_WORKER_GUARD_HTTP_NAME = "flair-multi-worker-guard";
/** The default REST middleware's http-entry name (auth-middleware.ts). */
export const FLAIR_AUTH_MIDDLEWARE_HTTP_NAME = "flair-auth-middleware";

/** The three states the guard can be in. */
export type MultiWorkerState = "single-worker" | "refused" | "unsafe-opt-in";

export interface MultiWorkerCondition {
  state: MultiWorkerState;
  /** Harper's effective worker count as read once, or null when it is not a positive integer. */
  workerCount: number | null;
}

/**
 * The /Health `multiWorker` field. Closed schema on purpose — /Health is public
 * and every worker renders this same value, so it carries only enumerated
 * strings and one coarse number: no message, no path, no request-scoped data.
 */
export interface MultiWorkerHealthField {
  state: "refused" | "unsafe-opt-in";
  workerCount: number | null;
  remedy: string;
}

/** The refusal body. Constant except the coarse worker count. */
export interface MultiWorkerRefusalBody {
  error: string;
  workerCount: number | null;
  remedy: string;
  detail: string;
}

/**
 * The pure decision, isolated so it is unit-testable without Harper.
 *
 * An unknown count (`null`) refuses: it is not a number, so it is not evidence
 * of one worker. A known count > 1 refuses unless the opt-in is set.
 */
export function decideMultiWorkerState(workerCount: number | null, optIn: boolean): MultiWorkerState {
  if (workerCount === null) return "refused";
  if (!(workerCount > 1)) return "single-worker";
  return optIn ? "unsafe-opt-in" : "refused";
}

/** The escape hatch, read from an env map (defaults to `process.env`). */
export function multiWorkerUnsafeOptIn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MULTI_WORKER_UNSAFE_ENV] === "1";
}

/** The condition's worker count as a label, naming an unreadable count as such. */
function workerCountLabel(condition: MultiWorkerCondition): string {
  return condition.workerCount === null
    ? "the worker count is unreadable"
    : `worker count=${condition.workerCount}`;
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
  const reason =
    "the multi-worker readiness work (flair#2052) is not complete — a per-worker embedding " +
    "engine and BM25 index, and the XAA jti record until flair#2073";
  if (condition.state === "refused") {
    return (
      `[multi-worker] refused: ${workerCountLabel(condition)}; flair does not serve on more than one ` +
      `Harper worker thread because ${reason}. Set ${MULTI_WORKER_REMEDY} and restart.`
    );
  }
  return (
    `[multi-worker] ${MULTI_WORKER_UNSAFE_ENV}=1 with ${workerCountLabel(condition)}: serving with ` +
    `the multi-worker readiness work outstanding — ${reason}. Set ${MULTI_WORKER_REMEDY} and unset ` +
    `${MULTI_WORKER_UNSAFE_ENV}.`
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
 * The named 503 for a refused request, or null when the request serves. Exempt
 * paths return null so /Health can render the refusal body. The opt-in serves
 * requests too; only /Health reports it.
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

/** A positive integer from `read()`, or null when the read throws or is not one. */
function readPositiveInteger(read: () => unknown): number | null {
  let raw: unknown;
  try {
    raw = read();
  } catch {
    return null;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return null;
  return raw;
}

/**
 * Harper's effective worker count for this thread, or null when it is unknown.
 *
 * `server.workerCount` is Harper's per-thread value: the configured count on a
 * worker thread, and 1 in the single-thread mode where the main thread is the
 * worker. On the main thread alongside worker threads it is `undefined`, so the
 * count falls back to Harper's effective configured count,
 * `server.config.threads.count`. Harper starts workers while `i < count`, so a
 * value that is not an integer (1.5) starts more workers than it names: a count
 * that is not a positive integer on either path — and a getter that throws — is
 * UNKNOWN, and the guard refuses it rather than read it as one worker.
 */
export function readWorkerCount(): number | null {
  const perThread = readPositiveInteger(
    () => (server as { workerCount?: unknown } | undefined)?.workerCount,
  );
  if (perThread !== null) return perThread;
  return readPositiveInteger(
    () =>
      ((server as { config?: { threads?: { count?: unknown } } } | undefined)?.config)?.threads?.count,
  );
}

/** The condition, resolved once per worker module instance. */
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

/**
 * The request guard, as its own http entry. It refuses a refused instance with
 * one named 503 and steps aside otherwise (including for /Health, which renders
 * the refusal itself).
 */
export async function multiWorkerRequestGuard(request: any, nextLayer: any): Promise<Response> {
  const pathname: string = typeof request?.pathname === "string" ? request.pathname : "/";
  const refusal = multiWorkerRefusalResponse(multiWorkerCondition(), pathname);
  if (refusal) return refusal;
  return nextLayer(request);
}

/** Test seam: forget the memoised condition so a test can re-resolve it. */
export function _resetMultiWorkerGuardForTests(): void {
  cached = null;
}

// Register the guard as its own http entry: runFirst, named, and ordered ahead
// of the default REST middleware. A urlPath mount pulls it in by name (see
// mcp-oauth.ts / oauth-wellknown.ts), so the refusal precedes the handlers on
// the default chain and on each mount that declares `after`. Skipped where
// `server.http` is absent (a partial mock outside a running Harper, where there
// is no dispatch to guard).
if (typeof (server as { http?: unknown } | undefined)?.http === "function") {
  server.http(multiWorkerRequestGuard, {
    runFirst: true,
    name: MULTI_WORKER_GUARD_HTTP_NAME,
    before: FLAIR_AUTH_MIDDLEWARE_HTTP_NAME,
  });
}

// Every worker loads this module once, so the named boot line is emitted once
// per worker module instance; every later read answers from the memoised
// condition.
announceMultiWorkerCondition();
