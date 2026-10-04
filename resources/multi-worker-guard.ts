import { server } from "harper";
import * as harper from "harper";

export const MULTI_WORKER_REFUSED_STATE = "multi-worker-unsupported";
export const MULTI_WORKER_ERROR_NAME = "multi_worker_unsupported";
export const MULTI_WORKER_REMEDY = "THREADS_COUNT=1";
export const MULTI_WORKER_UNSAFE_ENV = "FLAIR_MULTI_WORKER_UNSAFE";
export const MULTI_WORKER_GUARD_HTTP_NAME = "flair-multi-worker-guard";
export const FLAIR_AUTH_MIDDLEWARE_HTTP_NAME = "flair-auth-middleware";

export type MultiWorkerState = "single-worker" | "refused" | "unsafe-opt-in";

export interface MultiWorkerCondition {
  state: MultiWorkerState;
  workerCount: number | null;
}

export interface MultiWorkerHealthField {
  state: "refused" | "unsafe-opt-in";
  workerCount: number | null;
  remedy: string;
}

export interface MultiWorkerRefusalBody {
  error: string;
  workerCount: number | null;
  remedy: string;
  detail: string;
}

export function decideMultiWorkerState(workerCount: number | null, optIn: boolean): MultiWorkerState {
  if (workerCount === null) return "refused";
  if (!(workerCount > 1)) return "single-worker";
  return optIn ? "unsafe-opt-in" : "refused";
}

export function multiWorkerUnsafeOptIn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MULTI_WORKER_UNSAFE_ENV] === "1";
}

function workerCountLabel(condition: MultiWorkerCondition): string {
  return condition.workerCount === null
    ? "the worker count is unreadable"
    : `worker count=${condition.workerCount}`;
}

export function multiWorkerHealthField(condition: MultiWorkerCondition): MultiWorkerHealthField | null {
  if (condition.state === "single-worker") return null;
  return {
    state: condition.state,
    workerCount: condition.workerCount,
    remedy: condition.state === "refused" ? MULTI_WORKER_REMEDY : `${MULTI_WORKER_UNSAFE_ENV}=1`,
  };
}

export function multiWorkerBootLine(condition: MultiWorkerCondition): string | null {
  if (condition.state === "single-worker") return null;
  const reason =
    "the multi-worker readiness work (flair#2052) is not complete — a per-worker embedding " +
    "engine and BM25 index";
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

export function multiWorkerRefusalBody(condition: MultiWorkerCondition): MultiWorkerRefusalBody {
  return {
    error: MULTI_WORKER_ERROR_NAME,
    workerCount: condition.workerCount,
    remedy: MULTI_WORKER_REMEDY,
    detail:
      "flair does not serve on more than one Harper worker thread until the multi-worker readiness work lands.",
  };
}

export function isMultiWorkerExemptPath(pathname: string): boolean {
  return pathname === "/Health" || pathname === "/health";
}

export function multiWorkerRefusalResponse(
  condition: MultiWorkerCondition,
  pathname: string,
): Response | null {
  if (condition.state !== "refused" || isMultiWorkerExemptPath(pathname)) return null;
  return new Response(JSON.stringify(multiWorkerRefusalBody(condition)), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

let cached: MultiWorkerCondition | null = null;

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

export function resolveMultiWorkerCondition(): MultiWorkerCondition {
  if (cached) return cached;
  const workerCount = readWorkerCount();
  cached = { state: decideMultiWorkerState(workerCount, multiWorkerUnsafeOptIn()), workerCount };
  return cached;
}

export function multiWorkerCondition(): MultiWorkerCondition {
  return resolveMultiWorkerCondition();
}

export function announceMultiWorkerCondition(
  condition: MultiWorkerCondition = resolveMultiWorkerCondition(),
): void {
  const line = multiWorkerBootLine(condition);
  if (!line) return;
  const l = (harper as { logger?: { error?: (message: string) => void } }).logger;
  if (typeof l?.error === "function") l.error(line);
  else console.error(line);
}

export async function multiWorkerRequestGuard(request: any, nextLayer: any): Promise<Response> {
  const pathname: string = typeof request?.pathname === "string" ? request.pathname : "/";
  const refusal = multiWorkerRefusalResponse(multiWorkerCondition(), pathname);
  if (refusal) return refusal;
  return nextLayer(request);
}

export function _resetMultiWorkerGuardForTests(): void {
  cached = null;
}

if (typeof (server as { http?: unknown } | undefined)?.http === "function") {
  server.http(multiWorkerRequestGuard, {
    runFirst: true,
    name: MULTI_WORKER_GUARD_HTTP_NAME,
    before: FLAIR_AUTH_MIDDLEWARE_HTTP_NAME,
  });
}

announceMultiWorkerCondition();
