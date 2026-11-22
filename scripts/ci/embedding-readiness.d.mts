/** Declaration for scripts/ci/embedding-readiness.mjs. */

export const EMBEDDING_READY_DEADLINE_MS: number;
export const EMBEDDING_RETRY_BACKOFF_MS: number;
export const MAX_READINESS_ATTEMPTS: number;
export const PROVIDER_TIMEOUT_STATUS: number;
export const PROVIDER_TIMEOUT_ERROR: string;
export const OPS_TIMEOUT_MS: number;

export interface ReadinessConfirmation {
  ready: boolean;
  detail?: string;
}

export interface ReadinessResult {
  elapsedMs: number;
  attempts: number;
}

export interface AwaitEmbeddingReadyOptions {
  attempt: (remainingMs: number) => Promise<Response>;
  confirm?: (res: Response, remainingMs: number) => Promise<ReadinessConfirmation>;
  label?: string;
  deadlineMs?: number;
  backoffMs?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface WarmInstanceOptions {
  baseUrl: string;
  opsUrl: string;
  authHeader?: string;
  label?: string;
  deadlineMs?: number;
  backoffMs?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export interface WarmCliConfig {
  baseUrl: string;
  opsUrl: string;
  label: string;
  deadlineMs: number;
  authHeader: string;
}

export function isProviderTimeout(status: number, bodyText: string): boolean;
export function awaitEmbeddingReady(opts: AwaitEmbeddingReadyOptions): Promise<ReadinessResult>;
export function recordStepSummary(label: string, result: ReadinessResult): boolean;
export function createWarmAgent(opsUrl: string, authHeader: string, fetchImpl?: typeof fetch): Promise<string>;
export function warmInstanceEmbeddings(opts: WarmInstanceOptions): Promise<ReadinessResult>;
export function warmCliConfig(argv?: string[], env?: NodeJS.ProcessEnv): WarmCliConfig;
