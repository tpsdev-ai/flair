/**
 * One classifier for transport failures that can only happen while the
 * connection is being established, before any request bytes are written.
 * A caller may replay such a request on another configured instance; any other
 * transport failure may have delivered it, so it must not be replayed.
 *
 * Node's undici wraps the errno in the `fetch failed` TypeError's `cause`; Bun
 * puts `code` on the TypeError itself, and Bun may also name a refusal
 * `ConnectionRefused`. So the chain starts at the error and both refusal
 * spellings are accepted.
 *
 * Anything else (ECONNRESET, EPIPE, UND_ERR_SOCKET, UND_ERR_CLOSED, a bare
 * `fetch failed` with no code) may have been sent before the connection failed
 * and is NOT connect-phase (flair#2869).
 */

/** The refusal spellings, shared with daemon-liveness and upgrade-prior-liveness. */
export const REFUSED_CODES: readonly string[] = ["ECONNREFUSED", "ConnectionRefused"];

const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  ...REFUSED_CODES,
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** True when `err` or a `cause` in its chain carries a connect-phase code. */
export function isConnectPhaseFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth++) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && CONNECT_PHASE_CODES.has(code)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
