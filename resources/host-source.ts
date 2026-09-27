/**
 * host-source.ts — validation and canonicalisation for Memory.hostSource
 * (flair#1940 slice 1 / A2). PURE: zero imports (not even "harper"), so it can
 * be unit-tested directly and imported from any write path.
 *
 * A hostSource is a host-object pointer, versioned JSON:
 *   { "v": 1, "host": <closed set>, "kind": <closed set>, "id": <grammar>, "url"?: <https> }
 *
 * The server validates at write time and NEVER truncates or coerces: any
 * violation is a REFUSAL with a named error. The value stored is the CANONICAL
 * form — NFC-normalised values, keys in the fixed order v, host, kind, id, url.
 */

/** The initial closed vocabulary (A2). A PR that adds a pair extends this constant. */
export const HOST_SOURCE_HOSTS = Object.freeze(["openclaw", "cursor", "codex"] as const);
export const HOST_SOURCE_KINDS = Object.freeze(["run", "launch", "turn"] as const);

/** The host/kind PAIRS the server accepts (A2's initial set). */
export const HOST_SOURCE_PAIRS = Object.freeze([
  { host: "openclaw", kind: "run" },
  { host: "cursor", kind: "launch" },
  { host: "codex", kind: "turn" },
] as const);

/** The id grammar (A2). */
export const HOST_SOURCE_ID_RE = /^[A-Za-z0-9._:/@#-]{1,256}$/;

/** The url cap (A2), in characters. */
export const HOST_SOURCE_URL_MAX = 2048;

/** Control characters (C0, DEL, the C1 range U+0080-U+009F including U+0085)
 *  and the FULL bidi set (LRE/RLE/PDF/LRO/RLO U+202A-U+202E, the isolates
 *  U+2066-U+2069, and the marks LRM U+200E / RLM U+200F) are refused anywhere
 *  (A2). */
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

export interface HostSourceInput {
  v?: unknown;
  host?: unknown;
  kind?: unknown;
  id?: unknown;
  url?: unknown;
}

export type HostSourceResult =
  | { ok: true; canonical: string; value: { v: 1; host: string; kind: string; id: string; url?: string } }
  | { ok: false; error: string };

/** NFC-normalise a string value (returns it unchanged if already NFC). */
function nfc(s: string): string {
  return s.normalize("NFC");
}

/**
 * Validate and canonicalise a hostSource. Refuses (never truncates/coerces) on
 * any violation, naming the field and the reason.
 */
export function validateHostSource(input: unknown): HostSourceResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "hostSource must be an object" };
  }
  const obj = input as HostSourceInput;
  // Unknown top-level keys and any v other than 1 are refused (A2).
  const allowed = new Set(["v", "host", "kind", "id", "url"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return { ok: false, error: `hostSource: unknown key ${JSON.stringify(key)}` };
  }
  if (obj.v !== 1) return { ok: false, error: `hostSource: unsupported v ${JSON.stringify(obj.v)} (only 1)` };

  const field = (name: string, value: unknown): { ok: true; s: string } | { ok: false; error: string } => {
    if (typeof value !== "string") return { ok: false, error: `hostSource.${name} must be a string` };
    if (FORBIDDEN.test(value)) {
      return { ok: false, error: `hostSource.${name} contains a control character or bidi override` };
    }
    return { ok: true, s: nfc(value) };
  };

  const host = field("host", obj.host);
  if (!host.ok) return host;
  const kind = field("kind", obj.kind);
  if (!kind.ok) return kind;
  const id = field("id", obj.id);
  if (!id.ok) return id;

  // host/kind in the closed PAIR set.
  if (!HOST_SOURCE_HOSTS.includes(host.s as (typeof HOST_SOURCE_HOSTS)[number])) {
    return { ok: false, error: `hostSource.host ${JSON.stringify(host.s)} is not in the closed set` };
  }
  if (!HOST_SOURCE_KINDS.includes(kind.s as (typeof HOST_SOURCE_KINDS)[number])) {
    return { ok: false, error: `hostSource.kind ${JSON.stringify(kind.s)} is not in the closed set` };
  }
  if (!HOST_SOURCE_PAIRS.some((p) => p.host === host.s && p.kind === kind.s)) {
    return { ok: false, error: `hostSource host/kind ${JSON.stringify(`${host.s}/${kind.s}`)} is not an allowed pair` };
  }

  if (!HOST_SOURCE_ID_RE.test(id.s)) {
    return { ok: false, error: `hostSource.id ${JSON.stringify(id.s)} does not match the id grammar` };
  }

  // url is optional; https only, no userinfo, capped (A2).
  let url: string | undefined;
  if (obj.url !== undefined) {
    const u = field("url", obj.url);
    if (!u.ok) return u;
    if (u.s.length > HOST_SOURCE_URL_MAX) {
      return { ok: false, error: `hostSource.url exceeds ${HOST_SOURCE_URL_MAX} characters` };
    }
    let parsed: URL;
    try {
      parsed = new URL(u.s);
    } catch {
      return { ok: false, error: `hostSource.url ${JSON.stringify(u.s)} is not a valid URL` };
    }
    if (parsed.protocol !== "https:") return { ok: false, error: "hostSource.url must be https" };
    // Userinfo is refused — INCLUDING EMPTY userinfo ("https://@host/"), which
    // parses with parsed.username === "" and parsed.password === "" (A2 fix).
    // Detect the "@" in the authority directly so an empty userinfo cannot slip
    // through the username/password check.
    const authority = u.s.replace(/^https:\/\//i, "").split(/[/?#]/)[0];
    if (authority.includes("@") || parsed.username !== "" || parsed.password !== "") {
      return { ok: false, error: "hostSource.url must not carry userinfo" };
    }
    url = u.s;
  }

  const value: { v: 1; host: string; kind: string; id: string; url?: string } = {
    v: 1,
    host: host.s,
    kind: kind.s,
    id: id.s,
    ...(url !== undefined ? { url } : {}),
  };
  // Canonical serialization: fixed key order v, host, kind, id, url (A2).
  const canonical = JSON.stringify(value);
  return { ok: true, canonical, value };
}

/**
 * Parse a STORED hostSource string back to its value, or null when absent. The
 * reader never renders the raw string; a stored value that does not re-validate
 * reads as null (never a raw passthrough).
 */
export function parseHostSource(stored: unknown): { v: 1; host: string; kind: string; id: string; url?: string } | null {
  if (typeof stored !== "string" || stored.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  const r = validateHostSource(parsed);
  return r.ok ? r.value : null;
}
