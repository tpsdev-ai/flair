/**
 * The embedding provider's write refusal, shared by the writers that retry it.
 *
 * The server answers `503` with error code `memory_provider_timeout` when the
 * provider did not answer within its bound. The write-lock contract states
 * such a refusal wrote nothing, so replaying the write with the same id
 * cannot double-write the row.
 */
import { ApiHttpError, apiErrorRawBody } from "./auth-resolve.js";

/** Base wait before a retry of a memory write refused with `503 memory_provider_timeout`. */
export const MEMORY_PROVIDER_RETRY_DELAY_MS = 1_000;

/**
 * The server's `error` code on an `ApiHttpError`, parsed from the response body
 * that error carries (`apiErrorRawBody`; the message is never read). Returns
 * undefined for a non-HTTP error, an error that carries no body, or a body
 * without a string `error` field.
 */
export function apiErrorCode(err: unknown): string | undefined {
  const text = apiErrorRawBody(err);
  if (text === undefined) return undefined;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** A memory write refused with exactly 503 and `memory_provider_timeout`. */
export function isProviderTimeoutRefusal(err: unknown): boolean {
  return err instanceof ApiHttpError && err.status === 503 && apiErrorCode(err) === "memory_provider_timeout";
}
