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

/** Collect string code fields through cause and array-valued errors, skipping cycles. */
export function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const e = cur as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof e.code === "string") codes.push(e.code);
    if (e.cause !== undefined) stack.push(e.cause);
    if (Array.isArray(e.errors)) stack.push(...e.errors);
  }
  return codes;
}

/**
 * Match ECONNREFUSED or ConnectionRefused in collected codes or in the
 * top-level error text. Other text and codes do not match.
 */
export function isConnectionRefused(err: unknown): boolean {
  const codes = errorCodes(err);
  if (codes.includes("ECONNREFUSED") || codes.includes("ConnectionRefused")) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("ECONNREFUSED") || message.includes("ConnectionRefused");
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
