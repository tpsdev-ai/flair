/**
 * upgrade-prior-liveness.ts — was Flair up before `flair upgrade` swapped
 * packages? (flair#1740)
 *
 * Independent of post-upgrade verification. `--no-verify` still has to know
 * this, because a restart failure is not evidence against the new version
 * only when nothing was listening.
 *
 * Three outcomes, not two:
 *   - running        — /Health returned 2xx
 *   - stopped        — the connect was refused (nothing accepted the socket)
 *   - indeterminate  — timeout, non-2xx, reset, or any other failure
 *
 * Indeterminate is not "stopped". An unresponsive process is still a process.
 */

export type PriorLiveness =
  | { kind: "running" }
  | { kind: "stopped" }
  | { kind: "indeterminate"; reason: string };

export interface PriorLivenessOptions {
  /** Budget for the single /Health attempt. Default 3000ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** Walk `cause` and `AggregateError.errors` for a Node error code. */
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
 * True only for "nothing accepted the TCP connection".
 * Node reports `ECONNREFUSED`. Bun's fetch reports `ConnectionRefused`.
 * A timeout, a reset, or a generic "unable to connect" without that code
 * is not this signal.
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
 * One /Health attempt. Connection refused is the only "stopped" signal.
 * Anything else that is not 2xx is indeterminate — including a 3s timeout.
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
