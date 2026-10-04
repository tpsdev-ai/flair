/** Classify the pre-install /Health attempt for the restart-failure decision. */

export type PriorLiveness =
  | { kind: "running" }
  | { kind: "stopped" }
  | { kind: "indeterminate"; reason: string };

export interface PriorLivenessOptions {
  /** AbortSignal.timeout duration; defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3000;

const REFUSED_TOKENS = ["ECONNREFUSED", "ConnectionRefused"];

function namesRefusal(text: string): boolean {
  return REFUSED_TOKENS.some((token) => text.includes(token));
}

/**
 * Walk cause and array-valued errors, skipping cycles. Every string code must
 * be ECONNREFUSED or ConnectionRefused. Every uncoded failure without nested
 * failures must contain one of them in its text; an uncoded wrapper defers to
 * its nested failures. Any other code or leaf text does not match.
 */
export function isConnectionRefused(err: unknown): boolean {
  let matched = false;
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const cur = stack.pop();
    const isObject = !!cur && typeof cur === "object";
    if (isObject) {
      if (seen.has(cur)) continue;
      seen.add(cur);
    }
    const e = (isObject ? cur : {}) as { code?: unknown; cause?: unknown; errors?: unknown };
    const nested = [
      ...(e.cause !== undefined ? [e.cause] : []),
      ...(Array.isArray(e.errors) ? e.errors : []),
    ];
    if (typeof e.code === "string") {
      if (!REFUSED_TOKENS.includes(e.code)) return false;
      matched = true;
    } else if (nested.length === 0) {
      if (!namesRefusal(cur instanceof Error ? cur.message : String(cur ?? ""))) return false;
      matched = true;
    }
    stack.push(...nested);
  }
  return matched;
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "health probe failed");
}

/**
 * Fetch /Health once with a timeout signal. An ok response yields running;
 * a caught error matching isConnectionRefused yields stopped. Other responses
 * and caught errors yield indeterminate.
 */
export async function classifyUpgradePriorLiveness(
  baseUrl: string,
  opts: PriorLivenessOptions = {},
): Promise<PriorLiveness> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/Health`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { kind: "running" };
    return { kind: "indeterminate", reason: `HTTP ${res.status}` };
  } catch (err) {
    if (isConnectionRefused(err)) return { kind: "stopped" };
    return { kind: "indeterminate", reason: errorText(err) };
  }
}
