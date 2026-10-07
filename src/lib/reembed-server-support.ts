/**
 * reembed-server-support.ts — the server-support check `flair reembed` runs
 * before its first write (flair#2337).
 *
 * flair#2298 made the CLI re-embed a row by sending `PATCH /Memory/<id>` with
 * `{"embedding": null, "embeddingModel": null}`; the server recognises that
 * body and re-embeds the stored row. A server built before #2298 does not. A
 * CLI newer than its server is a supported state (`flair upgrade
 * --no-restart`, a bare npm install, an unrestarted service), so the CLI reads
 * the server's advertised capabilities from `GET /Health` before any write and
 * refuses when the token is absent or the response cannot be parsed.
 *
 * The parser and message builders are pure; the fetch adapter lives in
 * src/commands/reembed.ts.
 */

/**
 * This build advertises this /Health capability for the re-embed PATCH.
 * The shared constant aligns this build's CLI and server literals.
 * A missing token is intentionally refused even if an intermediate server
 * supports the PATCH.
 */
export const MEMORY_REEMBED_PATCH_CAPABILITY = "memory-reembed-patch";

/**
 * The capability names a /Health body advertises.
 *
 *   - an array of strings — the advertised capabilities (empty when the field
 *     is absent: an older server, or a build from before #2337 added it);
 *   - `null` — the field is present but not a string array. The client cannot
 *     interpret this shape, so the caller must treat the read as unverified
 *     rather than as "no capabilities".
 */
export function parseHealthCapabilities(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const caps = (body as { capabilities?: unknown }).capabilities;
  if (caps === undefined) return [];
  if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string")) return null;
  return caps as string[];
}

/** The server version a /Health body reports, or null when it carries none. */
export function healthVersion(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const v = (body as { version?: unknown }).version;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The remedy both refusal messages end with. */
export const REEMBED_SUPPORT_REMEDY =
  "Restart or upgrade the server, then re-run `flair reembed`.";

/** The refusal for a server that answered but does not advertise the capability. */
export function reembedUnsupportedMessage(version: string | null): string {
  return [
    "❌ flair reembed stopped before its first write: the server does not advertise the re-embed PATCH.",
    `   Found: server version ${version ?? "unknown"}, with no "${MEMORY_REEMBED_PATCH_CAPABILITY}" capability.`,
    `   ${REEMBED_SUPPORT_REMEDY}`,
  ].join("\n");
}

/** The refusal for a failed or unparseable /Health read. */
export function reembedUnverifiedMessage(detail: string): string {
  return [
    "❌ flair reembed stopped before its first write: could not confirm the server supports the re-embed PATCH.",
    `   Found: ${detail}.`,
    `   ${REEMBED_SUPPORT_REMEDY}`,
  ].join("\n");
}
