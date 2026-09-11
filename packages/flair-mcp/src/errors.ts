import { FlairError, formatKeyLookup, inspectKeyLookup } from "@tpsdev-ai/flair-client";
import { readEnvOrUnset } from "./env-guard.js";

export function classifyError(err: unknown, flairUrl: string): string {
  if (err instanceof FlairError) {
    const { status, body } = err;
    if (status === 400) return `validation_error: ${body}`;
    if (status === 401 || status === 403) {
      // flair#1271: name the agent, the paths that were looked in, and the
      // remedy. A cached-miss / wrong-HOME 401 is not a daemon-restart hint.
      const lookup = err.keyLookup ?? {
        ...inspectKeyLookup(
          readEnvOrUnset("FLAIR_AGENT_ID") ?? "",
          readEnvOrUnset("FLAIR_KEY_PATH"),
        ),
        signed: false,
        authMethod: "none" as const,
      };
      return `auth_error: ${body}\n${formatKeyLookup(lookup)}`;
    }
    if (status === 413) return `payload_too_large: ${body}`;
    if (status === 429) return "rate_limited — retry after a moment";
    if (status >= 500) return `server_error (retriable): ${body}`;
    return `http_error (${status}): ${body}`;
  }
  if (err instanceof Error) {
    if (err.name.includes("Abort") || err.name.includes("Timeout")) {
      return "timeout — the server took too long. This often happens with large content that requires embedding. Try shorter content or retry.";
    }
    if (err instanceof TypeError && err.message.includes("fetch")) {
      return `connection_error (retriable): could not reach Flair at ${flairUrl}. Is it running?\n` +
        `(Diagnostics:\n` +
        `  - 'curl ${flairUrl}/Health' — if this responds 200 or 401, daemon is up + this is an auth issue not a connection one.\n` +
        `  - 'launchctl list | grep flair' (macOS) or 'systemctl status flair' (Linux).)`;
    }
    return `unexpected_error: ${err.message}`;
  }
  return `unexpected_error: ${String(err)}`;
}
