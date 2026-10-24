/**
 * auth-resolve.ts — the ONE shared CLI credential resolver (flair#747).
 *
 * Before this file existed, every auth-requiring CLI surface hand-rolled its
 * own version of "how do I authenticate this request against a Flair
 * instance" — `api()`, `fetchHealthDetail()`, and `bootstrap` in src/cli.ts
 * each carried a slightly different, independently-maintained chain. The
 * worst gap: several of them never tried an Ed25519 agent key at all unless
 * an agentId was ALREADY known by some OTHER means, so a machine with a
 * perfectly good `~/.flair/keys/<agentId>.key` and nothing else (the normal
 * shape for a headless/agent machine) silently fell through to "no
 * credentials" on surfaces that a human operator's `~/.flair/admin-pass`
 * machine sailed through without noticing. flair#741/#742 fixed exactly
 * this for `flair upgrade`'s verification calls only (`verifyAuthedGet`,
 * still exported from src/cli.ts as a thin wrapper over `api()` below).
 * This module generalizes that fix into the floor every surface gets.
 *
 * ── Resolution order ─────────────────────────────────────────────────────
 *
 *   1. EXPLICIT — a caller-supplied credential: `explicitAdminPass` (e.g. a
 *      resolved `--admin-pass` flag) or `explicitKeyPath` (e.g. `--key`,
 *      paired with `agentId`). Always wins; this is the operator saying
 *      "use exactly this."
 *   1.5 A FLAG-PINNED agent (flair#1500) — `agentIdSource === "flag"`
 *      (`--agent X`). Signs as X BEFORE the env tier, and hard-errors if X
 *      has no key. An explicitly named identity is never quietly replaced.
 *   2. ENV — `FLAIR_TOKEN` (Bearer) or `FLAIR_ADMIN_PASS` / `HDB_ADMIN_
 *      PASSWORD` (Basic admin auth). Ambient but still an explicit
 *      operator/CI choice. (An ENV-pinned identity — `FLAIR_AGENT_ID` — stays
 *      BELOW this tier; see the never-silent notice below.)
 *   3. A PINNED agent identity — `agentId` was already known (an --agent
 *      flag, FLAIR_AGENT_ID env, or an id the caller extracted from its own
 *      request body/query string) — signed with THAT agent's key via the
 *      standard `resolveKeyPath` lookup. Deliberately ABOVE the admin-pass
 *      file: naming a specific agent identity is a deliberate choice that
 *      should win over the ambient convenience file (flair#634 precedent —
 *      preserved bit-for-bit; see test/unit/local-no-auth.test.ts).
 *   4. The secure `~/.flair/admin-pass` file `flair init` writes (LOCAL
 *      TARGETS ONLY — never sent to a --target/FLAIR_URL/FLAIR_TARGET
 *      remote instance; see `resolveLocalAdminPass`).
 *   5. THE FLOOR (flair#747, generalizing flair#742's upgrade-only
 *      fallback) — when NOTHING above resolved to anything sendable at
 *      all, sign the SAME request with every registered key under
 *      `~/.flair/keys` (sorted, deterministic order), first one the server
 *      accepts wins. This is the credential every headless/agent machine
 *      actually has, and is exactly the flair#741 incident's fix: an agent
 *      key existed the whole time, nothing tried it.
 *
 * Tier 5 ONLY ever engages when the primary attempt fails with
 * `ApiHttpError.noCredentials` — i.e. truly nothing was sent (a bare 403
 * with no Authorization header at all). A credential that WAS sent and got
 * rejected (bad admin pass, unregistered FLAIR_AGENT_ID) is a different,
 * more specific failure; guessing at unrelated keys on disk in that case
 * would obscure the real error instead of explaining it (the flair#741 fix
 * #3 lesson, applied here — see `sendJsonRequest`'s 403 branch).
 *
 * ── Named identity vs ambient credential: never a silent substitution ────
 * Precedence above is deliberately unchanged (flair#1504/#1507), but a caller
 * that NAMED an identity (`--agent` or `FLAIR_AGENT_ID`) and got a different,
 * usually more-privileged, credential is always told so on stderr — see
 * `describeIdentityOverride`/`emitIdentityOverrideNotice` below. A named
 * identity is never quietly upgraded to admin, and a two-explicit-flags
 * conflict (`--admin-pass` + `--agent`) is never quiet either.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";

import { join } from "node:path";
import { createPrivateKey, randomUUID, sign as nodeCryptoSign } from "node:crypto";
import type { SigningIdentitySource } from "./signing-identity.js";
import { resolveHome } from "./home.js";

// ─── Failure classification ─────────────────────────────────────────────────

/**
 * Thrown by `sendJsonRequest` for an HTTP-level failure (as opposed to a
 * network error, which fetch() itself throws before a status code ever
 * exists). Data-carrying, not just a message string, so callers downstream
 * can make decisions without re-parsing text (flair#741):
 *   - `status`: the HTTP status code, so probeInstance (src/probe.ts) can
 *     classify ProbeResult.authFailureKind (401/403 = credential failure,
 *     duck-typed off this property).
 *   - `noCredentials`: true only for the specific bare-403-no-auth-header
 *     case — distinguishes "we had nothing to send" from "we sent
 *     something and it was rejected", which is exactly the signal
 *     `authedRequest` uses to decide whether tier 5 (the floor) applies.
 *   - `body` (flair#2764): the display form of the response body, set by
 *     `fromResponse` (`displayBody`), with the credential values
 *     `credentialsInHeader` read from the request's Authorization header: a
 *     JSON body re-serialized with every string in it redacted after decoding,
 *     or withheld when it cannot be; any other body redacted as text; and any
 *     non-empty body withheld when that header names basic, bearer or
 *     tps-ed25519 but its credential could not be read (an empty body stays
 *     empty, and the message is then the status alone). The message's reason is decided
 *     separately (`describeHttpFailure`), from the unredacted text:
 *     BODY_WITHHELD for any non-empty body when the header's credential could
 *     not be read; otherwise the JSON body's named error, redacted, even when
 *     `body` is withheld; otherwise an excerpt of the text, redacted, or
 *     BODY_WITHHELD when displayBody withholds the body. Its `HTTP <status>`
 *     prefix is not passed through redaction. Classifiers read the unredacted
 *     text through `apiErrorRawBody`; the rem formatters that derive display
 *     text from it pass that text through `boundErrorText`, which redacts it,
 *     or withholds it when the header's credential could not be read and the
 *     response text was non-empty (even when the text derived from it is
 *     empty). Within
 *     the scope below, each of those values becomes `[redacted]` in the
 *     server's text as displayed.
 * Scope: redaction removes the request's credential values from the text the
 * server supplied (literal, inside any JSON string, percent-encoded); text the
 * CLI writes itself (the `HTTP <status>: ` prefix, the debug line's labels, a
 * caller's `Error: ` prefix) is never altered, so a credential that matches the
 * CLI's own wording, or matches only once that wording is joined to the
 * server's text, is not covered.
 */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly noCredentials: boolean;
  readonly body: string | undefined;
  constructor(status: number, message: string, noCredentials = false, body?: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.noCredentials = noCredentials;
    this.body = body;
  }

  /**
   * The error for a non-2xx response whose body text is `body` (flair#2764).
   * `sentValues` are the credential values `credentialsInHeader` read from the
   * request's Authorization header: the message and `body` are redacted with them
   * (within the scope on ApiHttpError). `withhold` is credentialsInHeader's
   * flag: when set, the server's non-empty text is shown as BODY_WITHHELD in the message
   * and `body`. The unredacted text, the values and the flag are kept in a
   * module-private map for apiErrorRawBody and boundErrorText.
   */
  static fromResponse(status: number, body: string, sentValues: readonly string[] = [], withhold = false): ApiHttpError {
    const err = new ApiHttpError(
      status,
      describeHttpFailure(status, body, sentValues, withhold),
      false,
      displayBody(body, sentValues, withhold),
    );
    privateText.set(err, { raw: body, sentValues: [...sentValues], withhold });
    return err;
  }
}

/**
 * An ApiHttpError's unredacted response text and the credential values its
 * request sent (flair#2764), kept for classification and redaction: only
 * apiErrorRawBody (the text) and boundErrorText (which uses the values to
 * redact) read this map. No field of the error holds the sent values; `body`
 * and the message are display forms of the raw text, which may equal it.
 */
const privateText = new WeakMap<ApiHttpError, { raw: string; sentValues: readonly string[]; withhold: boolean }>();

/** What a credential value the request sent becomes in the server's text as displayed. */
export const REDACTED_CREDENTIAL = "[redacted]";

/**
 * Copy of TPS_ED25519_HEADER_RE in resources/ed25519-auth.ts, the grammar
 * Flair's server parses a TPS-Ed25519 header with. The CLI build cannot import
 * from resources/, so test/unit/http-error-reason-2764.test.ts asserts the two
 * have the same source and flags (flair#2764).
 */
export const TPS_ED25519_HEADER_GRAMMAR = /^TPS-Ed25519\s+([^:\s]+):(\d+):([^:\s]+):(.+)$/i;

/** Copy of BASIC_AUTH_HEADER_RE in resources/basic-auth-header.ts, held to it by the same test (flair#2764). */
export const BASIC_HEADER_GRAMMAR = /^Basic /i;

/** The schemes credentialsInHeader extracts a credential from (lower case). */
const KNOWN_SCHEMES = new Set(["basic", "bearer", "tps-ed25519"]);

/** What credentialsInHeader reads from a sent Authorization header. */
export interface SentCredentials {
  /** The credential values to redact from the server's text. */
  values: string[];
  /** True when the header names a known scheme but its credential could not be extracted. */
  withhold: boolean;
}

/**
 * The credential values an Authorization header carries (flair#2764), read
 * from the value Fetch sends: the header with leading and trailing HTTP
 * whitespace (tab, line feed, carriage return, space) removed, as Fetch
 * normalizes it. The scheme is the text before the first run of whitespace
 * (any character the regular expression class for whitespace matches),
 * compared without regard to case. The values are that header value, the
 * part after the scheme (as written and with surrounding whitespace trimmed),
 * and for:
 *   - basic: the decoded `user:password` (or the decoded text, without a
 *     colon) and the password. When the header matches BASIC_HEADER_GRAMMAR,
 *     the server's own grammar, the decoded text is read as the server reads
 *     it (the text after its first six characters); otherwise from the part
 *     after the scheme;
 *   - tps-ed25519: the signature, read with TPS_ED25519_HEADER_GRAMMAR, the
 *     server's own grammar.
 * `withhold` is set when the scheme is basic, bearer or tps-ed25519 but no
 * decoded text, token or signature could be extracted that way; the server's
 * text is then withheld rather than shown. Empty values are left out.
 */
export function credentialsInHeader(authHeader: string | undefined): SentCredentials {
  if (!authHeader) return { values: [], withhold: false };
  const sent = authHeader.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  const scheme = (/^\S+/.exec(sent)?.[0] ?? "").toLowerCase();
  const credential = /^\S+\s+([\s\S]*)$/.exec(sent)?.[1] ?? "";
  const values = [sent, credential, credential.trim()];
  let extracted = false;
  if (scheme === "basic") {
    const encoded = BASIC_HEADER_GRAMMAR.test(sent) ? sent.slice(6) : credential.trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (decoded.length > 0) {
      const colon = decoded.indexOf(":");
      values.push(decoded);
      if (colon !== -1) values.push(decoded.slice(colon + 1));
      extracted = true;
    }
  } else if (scheme === "tps-ed25519") {
    const parsed = TPS_ED25519_HEADER_GRAMMAR.exec(sent);
    if (parsed) {
      values.push(parsed[4]!);
      extracted = true;
    }
  } else if (scheme === "bearer") {
    extracted = credential.trim().length > 0;
  }
  return { values: values.filter((value) => value.length > 0), withhold: KNOWN_SCHEMES.has(scheme) && !extracted };
}

const HEX2 = /^[0-9A-Fa-f]{2}$/;
const HEX4 = /^[0-9A-Fa-f]{4}$/;

/** The character each one-character JSON string escape (backslash, then this character) stands for. */
const JSON_SHORT_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * One decoded unit of credentialIntervals' view at `i` in `text`: the string it
 * stands for and how many characters of `text` it spans. A valid %XX escape
 * (either hex case) stands for its byte, given as a one-byte buffer; a JSON
 * string escape (backslash then one of the characters in JSON_SHORT_ESCAPES,
 * or backslash-u with four hex digits, a surrogate pair of two such escapes
 * read as one character) stands for its character; anything else stands for
 * itself.
 */
function viewUnit(text: string, i: number): { bytes: Buffer; width: number } {
  if (text[i] === "%" && HEX2.test(text.slice(i + 1, i + 3))) {
    return { bytes: Buffer.from([Number.parseInt(text.slice(i + 1, i + 3), 16)]), width: 3 };
  }
  if (text[i] === "\\" && i + 1 < text.length) {
    const next = text[i + 1]!;
    const short = JSON_SHORT_ESCAPES[next];
    if (short !== undefined) return { bytes: Buffer.from(short, "utf8"), width: 2 };
    if (next === "u" && HEX4.test(text.slice(i + 2, i + 6))) {
      const unit = Number.parseInt(text.slice(i + 2, i + 6), 16);
      if (unit >= 0xd800 && unit <= 0xdbff && text.slice(i + 6, i + 8) === "\\u" && HEX4.test(text.slice(i + 8, i + 12))) {
        const low = Number.parseInt(text.slice(i + 8, i + 12), 16);
        if (low >= 0xdc00 && low <= 0xdfff) {
          return { bytes: Buffer.from(String.fromCharCode(unit, low), "utf8"), width: 12 };
        }
      }
      if (unit < 0xd800 || unit > 0xdfff) return { bytes: Buffer.from(String.fromCharCode(unit), "utf8"), width: 6 };
    }
  }
  const width = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  return { bytes: Buffer.from(text.slice(i, i + width), "utf8"), width };
}

/**
 * Every occurrence in `text` of each value in `sentValues`, overlapping ones
 * included, as merged [start, end) intervals of `text` (flair#2764): intervals
 * that overlap or touch become one. A value is found where `text` holds it
 * literally, and, when `text` contains a "%" or a backslash, where `text`
 * spells it with %XX escapes (either hex case) or JSON string escapes, for all
 * or some of its characters: that search runs over a view of `text` with each
 * such escape decoded (viewUnit), and maps each match back to the characters
 * it came from. This holds whether or not `text` as a whole is valid JSON.
 */
function credentialIntervals(text: string, sentValues: readonly string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  const values = sentValues.filter((value) => value.length > 0);
  if (values.length === 0 || text.length === 0) return found;
  for (const value of values) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      found.push([at, at + value.length]);
    }
  }
  if (text.includes("%") || text.includes("\\")) {
    // bytes: the decoded view; from/to: the [start, end) of `text` each byte came from.
    const bytes: number[] = [];
    const from: number[] = [];
    const to: number[] = [];
    for (let i = 0; i < text.length; ) {
      const unit = viewUnit(text, i);
      for (const byte of unit.bytes) {
        bytes.push(byte);
        from.push(i);
        to.push(i + unit.width);
      }
      i += unit.width;
    }
    const view = Buffer.from(bytes);
    for (const value of values) {
      const needle = Buffer.from(value, "utf8");
      for (let at = view.indexOf(needle); at !== -1; at = view.indexOf(needle, at + 1)) {
        found.push([from[at]!, to[at + needle.length - 1]!]);
      }
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of found) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** `text` with each interval replaced by `marker`. */
function replaceIntervals(text: string, intervals: Array<[number, number]>, marker: string): string {
  if (intervals.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [start, end] of intervals) {
    out += text.slice(at, start) + marker;
    at = end;
  }
  return out + text.slice(at);
}

/** `text` when credentialIntervals finds no sent value in it, else `fallback` (flair#2764). */
function withoutOccurrence(text: string, sentValues: readonly string[], fallback: string): string {
  return credentialIntervals(text, sentValues).length === 0 ? text : fallback;
}

/**
 * Server-supplied `text` with each merged interval of credentialIntervals
 * replaced once by REDACTED_CREDENTIAL (flair#2764), in one pass: the server's
 * text left in the result holds no occurrence credentialIntervals finds. The
 * marker, and anything the CLI writes around the result, is not checked. The
 * scope is the one on ApiHttpError.
 */
export function redactSentCredentials(text: string, sentValues: readonly string[]): string {
  return replaceIntervals(text, credentialIntervals(text, sentValues), REDACTED_CREDENTIAL);
}

/**
 * A parsed JSON value with every string in it, object keys included, redacted,
 * and every number, boolean or null whose JSON text holds a sent value replaced
 * by the string REDACTED_CREDENTIAL (flair#2764).
 */
function redactJsonValues(value: unknown, sentValues: readonly string[]): unknown {
  if (typeof value === "string") return redactSentCredentials(value, sentValues);
  if (Array.isArray(value)) return value.map((item) => redactJsonValues(item, sentValues));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      out[redactSentCredentials(key, sentValues)] = redactJsonValues(item, sentValues);
    }
    return out;
  }
  return credentialIntervals(JSON.stringify(value), sentValues).length === 0 ? value : REDACTED_CREDENTIAL;
}

/** What displayBody shows for a body it cannot show: see displayBody. */
export const BODY_WITHHELD = "[body withheld]";

/**
 * A response body for display (flair#2764). A body JSON.parse rejects with a
 * SyntaxError (not JSON) is shown as received, redacted as text. A JSON body
 * is shown re-serialized, with every string in it (keys included) redacted
 * after JSON decoding and any other value whose JSON text holds a sent value
 * replaced; or as BODY_WITHHELD when it cannot be: when parsing fails any
 * other way (for example a nesting too deep to parse), when its redaction or
 * re-serialization fails, or when the re-serialized JSON still holds a sent
 * value (for example a value that occurs in JSON syntax). With `withhold` set
 * (credentialsInHeader), a non-empty body is shown as BODY_WITHHELD.
 */
function displayBody(body: string, sentValues: readonly string[], withhold = false): string {
  if (withhold && body.length > 0) return BODY_WITHHELD;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    if (err instanceof SyntaxError) return redactSentCredentials(body, sentValues);
    return BODY_WITHHELD;
  }
  try {
    return withoutOccurrence(JSON.stringify(redactJsonValues(parsed, sentValues)), sentValues, BODY_WITHHELD);
  } catch {
    return BODY_WITHHELD;
  }
}

/** What displayPath shows for a path it cannot show. */
export const PATH_WITHHELD = "[path withheld]";

/** C0 controls, DEL, C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * A request path for display (flair#2764): percent-decoded, then redacted.
 * PATH_WITHHELD when it does not decode or the decoded path holds a
 * CONTROL_CHARACTER.
 */
function displayPath(path: string, sentValues: readonly string[]): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return PATH_WITHHELD;
  }
  if (CONTROL_CHARACTER.test(decoded)) return PATH_WITHHELD;
  return redactSentCredentials(decoded, sentValues);
}

/** The most characters boundServerText keeps before it cuts the text and appends "..." (flair#2764). */
export const SERVER_TEXT_MAX_CHARS = 200;

/**
 * Server text as one line: control characters that are not whitespace are
 * removed, each run of whitespace (line breaks included) becomes one space,
 * and the ends are trimmed.
 */
function oneLine(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g, "")
    .replace(/[\s\u0085]+/g, " ")
    .trim();
}

/** `line` cut after SERVER_TEXT_MAX_CHARS characters, ending in "...", when it is longer. */
function cutToBound(line: string): string {
  let count = 0;
  let index = 0;
  for (const ch of line) {
    if (count === SERVER_TEXT_MAX_CHARS) return `${line.slice(0, index).trimEnd()}...`;
    count++;
    index += ch.length;
  }
  return line;
}

/**
 * Server text as one line: control characters that are not whitespace are
 * removed, each run of whitespace (line breaks included) becomes one space and
 * the ends are trimmed, and text longer than SERVER_TEXT_MAX_CHARS characters
 * is cut there and ends in "...".
 */
export function boundServerText(text: string): string {
  return cutToBound(oneLine(text));
}

/**
 * A private-use character no value in `sentValues` contains, standing in for
 * REDACTED_CREDENTIAL while boundAndRedact works: line-making leaves it alone
 * and no sent value can match it, so the second pass does not alter the marker.
 * The private-use ranges hold over 137,000 characters, more than an
 * Authorization header the transport sends can contain; were none free, the
 * marker itself would stand in.
 */
function standInFor(sentValues: readonly string[]): string {
  for (const [first, last] of [[0xe000, 0xf8ff], [0xf0000, 0xffffd], [0x100000, 0x10fffd]]) {
    for (let cp = first; cp <= last; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!sentValues.some((value) => value.includes(ch))) return ch;
    }
  }
  return REDACTED_CREDENTIAL;
}

/**
 * The text of `line` (holding stand-ins `standIn`, each displayed as
 * REDACTED_CREDENTIAL) that fits SERVER_TEXT_MAX_CHARS displayed characters,
 * ending before a stand-in that does not fit and never inside a %XX or JSON
 * string escape credentialIntervals decodes (viewUnit), with trailing
 * whitespace trimmed; null when all of `line` fits (flair#2764).
 */
function keptBeforeCut(line: string, standIn: string): string | null {
  let count = 0;
  let index = 0;
  let cut = -1;
  for (const ch of line) {
    const width = ch === standIn ? REDACTED_CREDENTIAL.length : 1;
    if (count + width > SERVER_TEXT_MAX_CHARS) {
      cut = index;
      break;
    }
    count += width;
    index += ch.length;
  }
  if (cut === -1) return null;
  let boundary = cut;
  if (line.includes("%") || line.includes("\\")) {
    for (let i = 0; i < cut; ) {
      const width = viewUnit(line, i).width;
      if (i + width > cut) {
        boundary = i;
        break;
      }
      i += width;
    }
  }
  return line.slice(0, boundary).trimEnd();
}

/**
 * boundServerText for output, with `sentValues` redacted from the server's
 * text (flair#2764). Order: redact, make one line, redact again, cut. Each
 * occurrence is replaced by a stand-in character (standInFor) while this
 * works; the first pass catches a credential before line-making can change it
 * (a whitespace run collapsed, a control character removed), and the second
 * catches one that line-making forms. The cut (keptBeforeCut) counts each
 * stand-in as the marker's length and falls between view units, so it splits
 * neither the marker nor an occurrence; then the stand-ins become
 * REDACTED_CREDENTIAL and "..." is appended to a cut text. Neither the marker
 * nor "..." is passed through redaction.
 */
function boundAndRedact(text: string, sentValues: readonly string[]): string {
  if (sentValues.length === 0) return boundServerText(text);
  const standIn = standInFor(sentValues);
  let line = oneLine(replaceIntervals(text, credentialIntervals(text, sentValues), standIn));
  line = replaceIntervals(line, credentialIntervals(line, sentValues), standIn);
  const shown = (t: string) => t.split(standIn).join(REDACTED_CREDENTIAL);
  const kept = keptBeforeCut(line, standIn);
  return kept === null ? shown(line) : `${shown(kept)}...`;
}

/**
 * The message of an ApiHttpError built from a response body (flair#2764):
 * `HTTP <status>`, then the body's named error when the body is a JSON object
 * with an `error`, else `code`, else `message` string that is non-empty once
 * bounded; otherwise an excerpt of the body, or BODY_WITHHELD when displayBody
 * withholds the body. The named error and the excerpt are read from the
 * unredacted body and go through boundAndRedact with `sentValues`. The
 * `HTTP <status>` prefix and BODY_WITHHELD are written by this function and
 * are not passed through redaction. With `withhold` set (credentialsInHeader),
 * the reason for a non-empty body is BODY_WITHHELD.
 */
export function describeHttpFailure(
  status: number,
  body: string,
  sentValues: readonly string[] = [],
  withhold = false,
): string {
  if (withhold && body.length > 0) return `HTTP ${status}: ${BODY_WITHHELD}`;
  let reason = "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const key of ["error", "code", "message"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string") reason = boundAndRedact(value, sentValues);
      if (reason) break;
    }
  }
  if (!reason) {
    reason = displayBody(body, sentValues) === BODY_WITHHELD ? BODY_WITHHELD : boundAndRedact(body, sentValues);
  }
  return reason ? `HTTP ${status}: ${reason}` : `HTTP ${status}`;
}

/**
 * The display form of the response body an ApiHttpError carries (`body`):
 * when fromResponse built the error, displayBody's form of the server's text,
 * redacted with the values credentialsInHeader read from its request's
 * Authorization header (within the scope on ApiHttpError), or withheld.
 * Undefined for any other error (flair#2764).
 */
export function apiErrorBody(err: unknown): string | undefined {
  return err instanceof ApiHttpError ? err.body : undefined;
}

/**
 * The unredacted response text, for code that classifies a failure by the
 * server's text (flair#2764). It may hold a credential the request sent:
 * classifiers read it, and text displayed from it goes through boundErrorText,
 * which redacts it within the scope on ApiHttpError or withholds it. For an
 * ApiHttpError not built by fromResponse it is `body`; undefined for any other
 * error.
 */
export function apiErrorRawBody(err: unknown): string | undefined {
  if (!(err instanceof ApiHttpError)) return undefined;
  return privateText.get(err)?.raw ?? err.body;
}

/**
 * `text` (taken from apiErrorRawBody) as one bounded line for output, with
 * the credential values credentialsInHeader read from `err`'s request header
 * redacted from it (boundAndRedact, within the scope on ApiHttpError), or
 * BODY_WITHHELD when credentialsInHeader set `withhold` for that header and
 * the response text `err` was built from is non-empty, whatever `text` is
 * (an empty `text` derived from it, such as an empty `error` string, included).
 * When that response text is empty nothing is withheld. For an error that has
 * no sent values, boundServerText(text) (flair#2764).
 */
export function boundErrorText(err: unknown, text: string): string {
  const kept = err instanceof ApiHttpError ? privateText.get(err) : undefined;
  if (kept?.withhold && kept.raw.length > 0) return BODY_WITHHELD;
  return boundAndRedact(text, kept?.sentValues ?? []);
}

/**
 * With FLAIR_DEBUG set (any non-empty value), write the display form of a
 * failed response's body to stderr as one JSON string (flair#2764). The path
 * is shown by displayPath (percent-decoded, then redacted, or withheld) and
 * the body by displayBody (a JSON body re-serialized, or withheld; any
 * non-empty body withheld when `withhold` is set, an empty one shown as ""),
 * each redacted within the scope on
 * ApiHttpError; the labels, method, status and the JSON encoding of the body
 * are written by this function and are not passed through redaction. In the
 * JSON-encoded body, DEL, C1 control characters and the Unicode line and
 * paragraph separators are escaped as well, so the line holds no
 * CONTROL_CHARACTER but its final newline. `sendJsonRequest` calls it where it
 * builds the error from the body. `env` and `write` are injectable for tests.
 */
export function emitHttpErrorBodyDebug(
  method: string,
  path: string,
  status: number,
  body: string,
  sentValues: readonly string[] = [],
  withhold = false,
  env: Record<string, string | undefined> = process.env,
  write: (s: string) => void = (s) => { process.stderr.write(s); },
): void {
  if (!env.FLAIR_DEBUG) return;
  const shownBody = JSON.stringify(displayBody(body, sentValues, withhold)).replace(
    /[\u007F-\u009F\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  write(`[flair] ${method} ${displayPath(path, sentValues)} answered HTTP ${status}; response body: ${shownBody}\n`);
}

// ─── Admin-pass file handling ───────────────────────────────────────────────

/**
 * Read a secret (admin password, Fabric password, ...) from a file, refusing
 * if the file is world/group readable.
 *
 * Secret files (default ~/.flair/admin-pass; also used for
 * --fabric-password-file) are short-lived values generated by `openssl
 * rand` — mode 0600 keeps them out of reach of other local users + most
 * backup tooling. A 0644 file silently leaks the secret to anyone with read
 * access to the user's home (multi-user hosts, NFS, time-machine snapshots,
 * etc.).
 *
 * Throws with an actionable error if the file isn't owner-only, otherwise
 * returns the trimmed file content (values generated by `openssl rand
 * -base64` conventionally end in a newline). `flagName` is only used to
 * personalize the error text (e.g. "--admin-pass-file" vs
 * "--fabric-password-file") — the check itself is identical either way.
 */
export function readSecretFileSecure(path: string, flagName: string): string {
  if (!existsSync(path)) {
    throw new Error(`${flagName} path does not exist: ${path}`);
  }
  const st = statSync(path);
  if (st.mode & 0o077) {
    const modeOctal = (st.mode & 0o777).toString(8).padStart(3, "0");
    throw new Error(
      `Refusing to read ${flagName} at ${path}: permissions ${modeOctal} are too open. ` +
        `Run \`chmod 600 ${path}\` to restrict to owner-only.`
    );
  }
  const content = readFileSync(path, "utf-8").replace(/\s+$/, "");
  if (!content) {
    throw new Error(`${flagName}: file is empty or contains only whitespace: ${path}`);
  }
  return content;
}

/** `readSecretFileSecure` specialized for --admin-pass-file (see that function for the shared check). */
export function readAdminPassFileSecure(path: string): string {
  return readSecretFileSecure(path, "--admin-pass-file");
}

/** Thrown by `resolveAdminPassFromSources` when two credential sources are given at once. */
export class AdminPassSourceError extends Error {}

export class AdminPassEmptyError extends Error {
  override name = "AdminPassEmptyError";
}

/**
 * Resolve an admin password from the credential sources a command exposes, in
 * the precedence its usage text states: an explicit option — `--admin-pass-file`
 * or `--admin-pass` (the form the help warns against) — over the ambient
 * `FLAIR_ADMIN_PASS`/`HDB_ADMIN_PASSWORD`. Explicit beats ambient, the same rule
 * `resolveLocalAdminPass` applies to `--admin-pass`, so a value the operator
 * typed is never silently replaced by one the shell happened to carry.
 * Supplying BOTH `--admin-pass-file` and `--admin-pass` is refused: two explicit
 * sources at once is ambiguous, and one of them is the discouraged argv form. The file is read through `readAdminPassFileSecure` — the same
 * reader `flair backup` uses — so a group- or world-readable file is refused
 * with a message naming the path and its mode.
 *
 * Returns "" when no source is set, so the caller owns its own "credential
 * required" message.
 */
export function resolveAdminPassFromSources(input: {
  adminPassFile?: string;
  adminPass?: string;
  envPass?: string;
}): string {
  const { adminPassFile, adminPass, envPass } = input;
  if (adminPassFile !== undefined && adminPass !== undefined) {
    throw new AdminPassSourceError(
      "--admin-pass and --admin-pass-file cannot be combined; pass exactly one. " +
        "Prefer --admin-pass-file: it keeps the password out of shell history and the process list.",
    );
  }
  if (adminPassFile !== undefined) {
    if (adminPassFile === "") throw new AdminPassEmptyError("--admin-pass-file must not be empty");
    return readAdminPassFileSecure(adminPassFile);
  }
  if (adminPass !== undefined) {
    if (adminPass === "") throw new AdminPassEmptyError("--admin-pass must not be empty");
    return adminPass;
  }
  return envPass ?? "";
}

export function defaultAdminPassPath(): string {
  return join(resolveHome(), ".flair", "admin-pass");
}

// ─── The ONE admin-password option surface (flair#1910) ─────────────────────
//
// Every command that declares the admin-password pair declares the SAME two
// flags with the SAME help, so the file form is recommended identically
// everywhere and the argv form always carries its leak warning. Defined here,
// next to the resolver both forms feed (`resolveAdminPassFromSources`), so the
// two surfaces cannot drift between `federation token`/`pair` (which declared
// these strings locally, flair#1873) and the shared credential-option helper
// every sibling command uses.
export const ADMIN_PASS_FILE_FLAG = "--admin-pass-file <path>";
export const ADMIN_PASS_FILE_HELP =
  "Read the admin password from an owner-only file (group and world permission bits are refused; an owner-only mode such as 0600 or 0400 is accepted), keeping it out of shell history and the process list. " +
  "An explicit option (this or --admin-pass) overrides FLAIR_ADMIN_PASS; combining it with --admin-pass is a usage error.";
export const ADMIN_PASS_FLAG = "--admin-pass <pass>";
export const ADMIN_PASS_HELP =
  "Admin password (legacy: lands in shell history and the process list — prefer --admin-pass-file or FLAIR_ADMIN_PASS)";

/** The admin username Harper's bootstrap creates and every Basic-auth path
 * historically hardcoded. Kept as the default; overridable per call via
 * `resolveAdminUser` (flair#1345). */
export const DEFAULT_ADMIN_USER = "admin";

/**
 * Resolve the admin USERNAME for Basic auth against a Flair/Harper instance
 * (flair#1345).
 *
 * Precedence: explicit value (an `--admin-user` flag) → `FLAIR_ADMIN_USER`
 * env → `"admin"`. Always returns a usable name — unlike the password there
 * is no "missing" state, because `admin` is the correct answer for every
 * instance `flair init` ever bootstrapped.
 *
 * Why it exists: with `authorizeLocal: false` (the #604/#610 hardening) the
 * CLI must send real Basic admin auth, and on an instance whose superuser is
 * not named `admin` there was no way to say so — `--admin-pass` existed,
 * the username didn't. A wrong username and a wrong password produce the
 * SAME 401 "Login failed" from Harper, so this also feeds the 401 hint text
 * (see opsAuth401Hint in src/cli.ts).
 *
 * Unlike the admin PASSWORD (see resolveLocalAdminPass's remote-target
 * guard), the env leg is honored for remote targets too: a username is not a
 * secret — sending the wrong one to a third-party host leaks nothing and
 * fails closed with a 401.
 */
export function resolveAdminUser(explicit?: string): string {
  return explicit || process.env.FLAIR_ADMIN_USER || DEFAULT_ADMIN_USER;
}

export function defaultKeysDir(): string {
  return join(resolveHome(), ".flair", "keys");
}

/**
 * Resolve an admin password for LOCAL-only CLI convenience (`agent add`,
 * `principal add`) without requiring `--admin-pass` on every call (#590).
 * Also reused by `authedRequest`'s tier 4 (local-target file fallback,
 * flair#634) — called there as `resolveLocalAdminPass(undefined,
 * !isLocal)`, so only its file leg ever fires (the env leg is already
 * handled by tier 2 first).
 *
 * Resolution order: explicit value (the `--admin-pass` flag) → `FLAIR_ADMIN_PASS`
 * env → the secure `~/.flair/admin-pass` file `flair init` already writes with
 * mode 0600 (read via `readAdminPassFileSecure`, which enforces that mode).
 *
 * When `isRemoteTarget` is true, ONLY the explicit value is honored — the env
 * and file legs are skipped entirely. This is the security-critical guard: a
 * `--target`/`--ops-target` deploy must never silently reuse THIS machine's
 * local admin secret against someone else's Harper instance. Remote callers
 * keep requiring an explicit `--admin-pass`.
 *
 * ── Both legs, not just the file (flair#1085) ────────────────────────────────
 * An operator reported this as a bug: `--help` and the error both promised
 * `FLAIR_ADMIN_PASS` would work, and for a remote target it silently did not.
 * The promise was wrong, not the guard — but the codebase disagreed with itself,
 * which is why it read as a defect. One call site's comment described the goal as
 * blocking only the *file* fallback, this doc described blocking both, and the
 * user-facing strings described neither.
 *
 * The env leg is skipped **deliberately**, and the reasoning is worth keeping:
 * an exported `FLAIR_ADMIN_PASS` is not evidence of intent toward THIS target. It
 * persists across a shell session, so an operator who set it for their local
 * instance and later types `--instance https://someone-elses-host` would send a
 * local admin credential to a third party — silently, and with no way to notice.
 * "The operator exported it" and "the operator meant it for this host" are
 * different claims, and only the explicit flag asserts the second.
 *
 * If that trade is ever revisited, revisit it here rather than at a call site:
 * the guard is one line and the reasoning is not obvious from it.
 *
 * Throws (via readAdminPassFileSecure) if the file exists but has unsafe
 * permissions, so a misconfigured file surfaces as an actionable chmod error
 * instead of a generic "admin pass required" message.
 */
export function resolveLocalAdminPass(
  explicit: string | undefined,
  isRemoteTarget = false,
  adminPassPath: string = defaultAdminPassPath(),
): string | undefined {
  if (explicit) return explicit;
  if (isRemoteTarget) return undefined;
  if (process.env.FLAIR_ADMIN_PASS) return process.env.FLAIR_ADMIN_PASS;
  if (!existsSync(adminPassPath)) return undefined;
  return readAdminPassFileSecure(adminPassPath);
}

// ─── Ed25519 agent-key signing ──────────────────────────────────────────────

/** Find the agent's private key file from standard locations. */
export function resolveKeyPath(agentId: string): string | null {
  const candidates = [
    process.env.FLAIR_KEY_DIR ? join(process.env.FLAIR_KEY_DIR, `${agentId}.key`) : null,
    join(resolveHome(), ".flair", "keys", `${agentId}.key`),
    join(resolveHome(), ".tps", "secrets", "flair", `${agentId}-priv.key`),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Build a TPS-Ed25519 auth header from a raw 32-byte seed on disk. */
export function buildEd25519Auth(agentId: string, method: string, path: string, keyPath: string): string {
  const raw = readFileSync(keyPath);
  const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
  let privKey: ReturnType<typeof createPrivateKey>;
  if (raw.length === 32) {
    // Raw 32-byte seed
    privKey = createPrivateKey({ key: Buffer.concat([pkcs8Header, raw]), format: "der", type: "pkcs8" });
  } else {
    // Try as base64-encoded PKCS8 DER (standard Flair key format)
    const decoded = Buffer.from(raw.toString("utf-8").trim(), "base64");
    if (decoded.length === 32) {
      // Base64-encoded raw seed
      privKey = createPrivateKey({ key: Buffer.concat([pkcs8Header, decoded]), format: "der", type: "pkcs8" });
    } else {
      // Full PKCS8 DER or PEM
      try {
        privKey = createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
      } catch {
        privKey = createPrivateKey(raw);
      }
    }
  }
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = nodeCryptoSign(null, Buffer.from(payload), privKey).toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig}`;
}

/** Join a Flair route to an optional base path before signing or sending it. */
export function requestUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  if (base.search || base.hash || /[?#]$/.test(baseUrl)) {
    throw new Error("Flair base URL must not contain a query or fragment");
  }
  const route = new URL(path, base.origin);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${route.pathname}`;
  base.search = route.search;
  return base;
}

export function requestTarget(url: URL): string {
  return `${url.pathname}${url.search}`;
}

// ─── Key-load failures, told apart from transport failures (flair#1023) ─────
//
// An unparseable key file used to reach callers as a bare Error out of
// authFetch, indistinguishable from `fetch` rejecting. Every caller with a
// single `catch` around "sign, then send" therefore attributed it to the
// network — `flair doctor` reported an operator's undecodable key as
// "instance unreachable", six lines under its own `✓ Harper responding`.
//
// The fix is structural, not a better guess: signing STRICTLY precedes the
// request, so the phase that failed is already known at the point of failure
// and no longer has to be inferred from the error text. authFetch wraps only
// the signing half in KeyLoadError; anything thrown after that is genuinely
// transport. A caller that wants to tell them apart does `instanceof`, and
// one that doesn't keeps working — KeyLoadError is an Error whose `message`
// is strictly more informative than what it replaces.

/**
 * Why a key file could not be turned into a usable signing key.
 *
 * "unknown" is a real, load-bearing member, not a fallback to tidy up later:
 * an unrecognised failure must stay unrecognised so callers report the raw
 * error instead of asserting a cause they haven't established (flair#1023).
 */
export type KeyLoadFailureKind = "not-found" | "unreadable" | "decode" | "unknown";

/**
 * Classify a throw from `buildEd25519Auth`.
 *
 * Keyed on the STRUCTURED `code` property rather than on message text,
 * because the message is not stable across crypto backends. Probed directly
 * on the same 60-byte malformed input:
 *
 *   Node (OpenSSL)   ERR_OSSL_UNSUPPORTED       error:1E08010C:DECODER routines::unsupported
 *                    ERR_OSSL_ASN1_WRONG_TAG    error:068000A8:asn1 encoding routines::wrong tag
 *   Bun (BoringSSL)  ERR_OSSL_NO_START_LINE     error:0900006e:PEM routines:...:NO_START_LINE
 *                    ERR_OSSL_WRONG_TAG         error:0c0000be:ASN.1 encoding routines:...:WRONG_TAG
 *
 * The first line is the error in flair#1023, and matching it alone would have
 * left the tests (bun) and the shipped CLI (node) classifying differently.
 * So the rule is the `ERR_OSSL_` family as a whole — sound here because
 * buildEd25519Auth does no I/O beyond reading the file: any crypto-backend
 * error it raises is about the key, never about the instance. Message text is
 * a secondary signal only, for a backend that reports no code we recognise.
 */
export function classifyKeyLoadFailure(err: unknown): KeyLoadFailureKind {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (code === "ENOENT") return "not-found";
  if (code === "EACCES" || code === "EPERM" || code === "EISDIR") return "unreadable";
  if (code.startsWith("ERR_OSSL")) return "decode";
  const message = err instanceof Error ? err.message : String(err ?? "");
  // `asn\.?1` because the two backends punctuate it differently:
  // "asn1 encoding routines" (OpenSSL) vs "ASN.1 encoding routines" (BoringSSL).
  if (/DECODER routines|asn\.?1 encoding routines|PEM routines/i.test(message)) return "decode";
  return "unknown";
}

/** A signing key could not be loaded — distinct from the instance being down. */
export class KeyLoadError extends Error {
  /** The file we tried to read. Known at the point of failure; used to be discarded. */
  readonly keyPath: string;
  readonly kind: KeyLoadFailureKind;
  /** The underlying error's message, preserved verbatim for the operator. */
  readonly underlying: string;

  constructor(keyPath: string, kind: KeyLoadFailureKind, underlying: string) {
    super(describeKeyLoadFailure(keyPath, kind, underlying));
    this.name = "KeyLoadError";
    this.keyPath = keyPath;
    this.kind = kind;
    this.underlying = underlying;
  }

  static from(keyPath: string, err: unknown): KeyLoadError {
    const underlying = err instanceof Error ? err.message : String(err ?? "");
    return new KeyLoadError(keyPath, classifyKeyLoadFailure(err), underlying);
  }
}

/**
 * One line an operator can act on: what we were doing, which file, and — only
 * when it has actually been established — why. The "unknown" arm deliberately
 * states no cause and shows the raw error instead (flair#1023 requirement 1).
 */
export function describeKeyLoadFailure(keyPath: string, kind: KeyLoadFailureKind, underlying: string): string {
  switch (kind) {
    case "not-found":
      return `signing key ${keyPath} does not exist`;
    case "unreadable":
      return `signing key ${keyPath} could not be read (${underlying})`;
    case "decode":
      return `signing key ${keyPath} could not be parsed as an Ed25519 private key (${underlying})`;
    case "unknown":
      // No cause is asserted — we genuinely do not know one.
      return `signing key ${keyPath} could not be loaded: ${underlying}`;
  }
}

/**
 * Authenticated fetch against Flair using Ed25519.
 *
 * Throws {@link KeyLoadError} if the key could not be loaded — a failure that
 * provably happened BEFORE any byte hit the network, so no caller need guess
 * whether the instance is reachable. A URL that cannot be built is refused
 * before signing or sending. `fetch` can fail before transport (for example,
 * request construction can reject an invalid header) or during transport;
 * failures are not classified here.
 */
export async function authFetch(
  baseUrl: string,
  agentId: string,
  keyPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = requestUrl(baseUrl, path);
  let auth: string;
  try {
    auth = buildEd25519Auth(agentId, method, requestTarget(url), keyPath);
  } catch (err: unknown) {
    throw KeyLoadError.from(keyPath, err);
  }
  const headers: Record<string, string> = { Authorization: auth };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(url.href, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function isLocalBase(base: string): boolean {
  try {
    const url = new URL(base);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return !base;
  }
}

// ─── HTTP + response handling ───────────────────────────────────────────────

/**
 * The signing context of a `signedOnly` request (flair#2749), for its
 * no-credentials 403 hint: the agent id the request names, if any, and the
 * directory the tier-5 floor reads keys from.
 */
export interface SignedOnlyHintContext {
  agentId?: string;
  keysDir: string;
}

function noCredentialsHint(isLocal: boolean, signedOnly: SignedOnlyHintContext | undefined): string {
  if (signedOnly) {
    // No admin password leaves a signedOnly request, so only an agent key helps.
    const remedy = signedOnly.agentId
      ? `Provide the key of agent '${signedOnly.agentId}' at ${join(defaultKeysDir(), `${signedOnly.agentId}.key`)} ` +
        `(or set FLAIR_KEY_DIR to a directory containing ${signedOnly.agentId}.key).`
      : `Provide the key of an agent registered on the target instance at ${join(signedOnly.keysDir, "<agent-id>.key")}.`;
    return `This request can send only an Ed25519 agent signature; the admin password is not sent on this path. ${remedy}`;
  }
  return isLocal
    ? "Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass or an agent key."
    : "Set FLAIR_ADMIN_PASS (remote targets have no local admin-pass fallback).";
}

/**
 * Perform the actual Flair REST call with an already-resolved Authorization
 * header (or none) and classify the response. Shared by the primary
 * (tiers 1-4) attempt and each tier-5 floor attempt below, so both paths
 * agree on 204/empty-body handling, JSON parsing, and the no-credentials
 * 403 hint text.
 */
export async function sendJsonRequest(
  url: URL,
  method: string,
  body: unknown,
  authHeader: string | undefined,
  isLocal: boolean,
  transport: { refuseRedirects?: boolean; signedOnly?: SignedOnlyHintContext } = {},
): Promise<any> {
  const res = await fetch(url.href, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // "manual" hands back the 3xx itself, so the refusal can name its status;
    // the location it names is never requested.
    ...(transport.refuseRedirects ? { redirect: "manual" as const } : {}),
  });
  if (transport.refuseRedirects && res.status >= 300 && res.status < 400) {
    throw new ApiHttpError(res.status, `HTTP ${res.status}: the instance answered with a redirect, which this request does not follow`);
  }
  // 403 with no credentials sent at all is the flair#634 case: a gated
  // resource rejected a credential-less call. Name the fix instead of
  // surfacing the raw "forbidden" body — never a stack trace. Classified
  // before the empty-body shortcut below, so a zero-length 403 gets the same
  // hint and noCredentials as one with a body (flair#2749).
  if (res.status === 403 && !authHeader) {
    await res.text();
    const hint = noCredentialsHint(isLocal, transport.signedOnly);
    throw new ApiHttpError(403, `HTTP 403: no credentials sent. ${hint}`, /* noCredentials */ true);
  }
  // Handle 204 No Content (e.g., PUT upsert returns empty body)
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    if (!res.ok) throw ApiHttpError.fromResponse(res.status, "");
    return { ok: true };
  }
  const text = await res.text();
  if (!res.ok) {
    // The FLAIR_DEBUG line's path and body, the message's reason and `body`
    // are redacted with the credential values credentialsInHeader reads from
    // this request's Authorization header, within the scope on ApiHttpError,
    // and the server's text is withheld when it sets `withhold`; classifiers
    // read the unredacted text through apiErrorRawBody.
    const sent = credentialsInHeader(authHeader);
    emitHttpErrorBodyDebug(method, url.pathname, res.status, text, sent.values, sent.withhold);
    throw ApiHttpError.fromResponse(res.status, text, sent.values, sent.withhold);
  }
  if (!text) return { ok: true };
  return JSON.parse(text);
}

/**
 * Tier 5, the floor (flair#747, generalizing flair#742's `verifyAuthedGet`
 * GET-only fallback to any method/body): try every registered key in
 * `keysDir` in sorted (deterministic) filename order, first one that
 * authenticates wins. Returns `undefined` — never throws — when every key
 * fails or none exist, so the caller can rethrow its ORIGINAL
 * no-credentials error rather than a floor-specific one.
 */
export async function tryAgentKeyFloor(
  url: URL,
  method: string,
  body: unknown,
  keysDir: string,
  transport: { refuseRedirects?: boolean } = {},
): Promise<any> {
  let keyFiles: string[] = [];
  try {
    keyFiles = readdirSync(keysDir).filter((f) => f.endsWith(".key")).sort();
  } catch {
    // No keys dir at all — nothing to fall back to.
  }
  const isLocal = isLocalBase(url.origin);
  for (const kf of keyFiles) {
    const agentId = kf.replace(/\.key$/, "");
    const keyPath = join(keysDir, kf);
    try {
      const authHeader = buildEd25519Auth(agentId, method, requestTarget(url), keyPath);
      return await sendJsonRequest(url, method, body, authHeader, isLocal, transport);
    } catch {
      // This key didn't work (unregistered, bad signature, network blip on
      // this one attempt) — try the next one.
    }
  }
  return undefined;
}

// ─── Named identity vs ambient credential: never a silent substitution ───────
//
// flair#1500's core fix (tier 1.5, below) makes a *flag-pinned* `--agent X`
// sign as X before any ambient admin credential, and hard-errors when X has no
// key. That covers the explicit-flag case completely. Two substitutions in the
// same class stayed silent after #1504:
//
//   • an ENV-pinned identity (`FLAIR_AGENT_ID`) is still outranked by an
//     ambient/explicit admin credential — the reviewer-blessed precedence
//     (#1504 kept it "as today"), but nothing told the operator their named
//     identity was ignored;
//   • an explicit `--admin-pass` alongside a flag-pinned `--agent X` is a
//     genuine two-explicit-flags conflict (#1506) that resolved to admin
//     silently.
//
// Precedence is a deliberate, reviewed design decision (#1504 whitelist;
// #1507 item 5 explicitly leaves "should ambient admin outrank an env-pinned
// agent?" to the maintainer). This module therefore does NOT flip it. It
// removes the *silence*: whenever a caller named an identity and a different,
// usually more-privileged, credential is what actually signs, the resolver
// says so on stderr — naming the identity, the winning credential, and how to
// get the behaviour the caller asked for. A named identity is never quietly
// upgraded to admin, and a conflict is never quiet either.
//
// A hard error is deliberately NOT used for `--admin-pass` + `--agent`: that
// pair is the documented "admin acts on behalf of a named row owner" path
// (the keyed `flair soul set --agent X --admin-pass …` onboarding flow relies
// on it), and the first `--agent`-only precedence already fails closed when no
// key exists.

/** Which tier actually supplied the Authorization header for a request. */
export type ResolvedCredentialSource =
  | "explicit-admin"
  | "explicit-key"
  | "flag-agent"
  | "env-token"
  | "env-admin"
  | "pinned-agent"
  | "local-admin-file";

/** Inputs to {@link describeIdentityOverride} — all pure, no process state. */
export interface IdentityOverrideInput {
  /** The identity the caller named (`--agent` flag or `FLAIR_AGENT_ID` env). */
  agentId: string;
  /** How it was named: `flag` (`--agent`) or `env` (`FLAIR_AGENT_ID`). */
  namedSource: "flag" | "env";
  /** Which credential actually signed the request. */
  credentialSource: ResolvedCredentialSource;
  /** The env var that supplied the ambient admin password, when that signed. */
  adminPassEnvVar?: string;
}

/**
 * One actionable line for a named identity that was not the signer, or `null`
 * when the named identity itself signed (the normal, expected case). Pure and
 * exported so the matrix is unit-testable without spawning the CLI.
 */
export function describeIdentityOverride(input: IdentityOverrideInput): string | null {
  const { agentId, namedSource, credentialSource, adminPassEnvVar } = input;
  const named = namedSource === "flag" ? `--agent '${agentId}'` : `FLAIR_AGENT_ID='${agentId}'`;
  switch (credentialSource) {
    case "flag-agent":
    case "pinned-agent":
    case "explicit-key":
      // The named identity signed — nothing was overridden.
      return null;
    case "explicit-admin":
      return `Warning: ${named} names an identity, but --admin-pass was also given; signing as admin. Drop --admin-pass to sign as '${agentId}'.`;
    case "env-token":
      return `Warning: ${named} names an identity, but FLAIR_TOKEN is set; signing with that bearer token instead. Unset FLAIR_TOKEN to sign as '${agentId}'.`;
    case "env-admin":
      return `Warning: ${named} names an identity, but an ambient admin password (${adminPassEnvVar ?? "FLAIR_ADMIN_PASS"}) is set; signing as admin. Unset it to sign as '${agentId}'.`;
    case "local-admin-file":
      return `Warning: ${named} names an identity, but no key was found for it and the local ~/.flair/admin-pass file is present; signing as admin. Add a key for '${agentId}' to sign as it.`;
  }
}

// De-duplicate in one process (a command may issue several requests) so an
// operator sees the notice once, not once per call. Tests reset it explicitly.
const emittedIdentityOverrides = new Set<string>();

/** Write an override notice to stderr once per process. Injectable for tests. */
export function emitIdentityOverrideNotice(
  message: string,
  write: (s: string) => void = (s) => { process.stderr.write(s); },
): void {
  if (emittedIdentityOverrides.has(message)) return;
  emittedIdentityOverrides.add(message);
  write(message + "\n");
}

/** Test hook: forget notices already emitted in this process. */
export function resetIdentityOverrideNotices(): void {
  emittedIdentityOverrides.clear();
}

// ─── The unified resolver ───────────────────────────────────────────────────

export interface AuthedRequestOptions {
  /** Base URL of the Flair instance (e.g. http://127.0.0.1:19926). */
  baseUrl: string;
  /** Pre-computed isLocal; derived from baseUrl via isLocalBase when omitted. */
  isLocal?: boolean;
  /** Tier 1 — an already-resolved explicit admin credential (e.g. a
   *  --admin-pass flag the caller checked before its own env fallback). */
  explicitAdminPass?: string;
  /** Tier 1 — an explicit key file path (e.g. --key). Requires `agentId`;
   *  wins over env and the standard resolveKeyPath(agentId) lookup. */
  explicitKeyPath?: string;
  /** An agentId already pinned for this call — an --agent flag,
   *  FLAIR_AGENT_ID env, or an id the caller extracted from its own
   *  request body/query string. Used by both the explicit-key tier (the
   *  identity `explicitKeyPath` signs for) and tier 3's standard
   *  resolveKeyPath(agentId) lookup. */
  agentId?: string;
  /** Which tier resolved `agentId` — "flag" (--agent), "env" (FLAIR_AGENT_ID),
   *  "config", or "none". Only "flag" triggers the flag-pinned step
   *  (flair#1500): a flag-pinned agent signs as itself BEFORE env admin, and a
   *  flag-pinned agent with no key on disk is a hard error. */
  agentIdSource?: SigningIdentitySource;
  /** Directory scanned for tier 5, the floor. Default ~/.flair/keys. */
  keysDir?: string;
  /** Admin USERNAME for the Basic-auth tiers (1, 2 and 4) — an already-
   *  resolved `--admin-user` flag. Falls back to FLAIR_ADMIN_USER env, then
   *  `"admin"`, via resolveAdminUser (flair#1345). */
  adminUser?: string;
  /**
   * Send no shared secret (flair#2526): no Basic and no Bearer header, from any
   * source (an explicit admin pass is refused; FLAIR_TOKEN, FLAIR_ADMIN_PASS,
   * HDB_ADMIN_PASSWORD and ~/.flair/admin-pass are skipped). Only an Ed25519
   * agent signature, or nothing, goes out. For a target whose instance is not
   * proven, such as `flair doctor`'s listener-only fallback.
   */
  signedOnly?: boolean;
  /**
   * Refuse a redirect instead of following it (flair#2708): the location a 3xx
   * names receives no request, and that attempt throws `ApiHttpError` with its
   * status. When the request falls back across agent keys (no resolved
   * credential), the fallback loop catches that error like any other attempt's,
   * so the caller can receive an earlier attempt's answer or a later key's
   * success instead. Unset, a redirect is followed (fetch's default), as for
   * every caller that does not pass this.
   */
  refuseRedirects?: boolean;
}

/** The Authorization scheme of an Ed25519 agent signature (buildEd25519Auth). */
const ED25519_SCHEME = "TPS-Ed25519 ";

/**
 * The shared resolver: given a Flair REST call and whatever credential
 * material the caller already knows about, resolve auth across all 5 tiers
 * (see module header) and perform the request. Throws `ApiHttpError` on
 * any non-2xx response (after the tier-5 floor has also been exhausted).
 */
export async function authedRequest(
  method: string,
  path: string,
  body: unknown,
  opts: AuthedRequestOptions,
): Promise<any> {
  const url = requestUrl(opts.baseUrl, path);
  const signedPath = requestTarget(url);
  const isLocal = opts.isLocal ?? isLocalBase(opts.baseUrl);
  const keysDir = opts.keysDir ?? defaultKeysDir();
  // One username for every Basic tier: flag > FLAIR_ADMIN_USER env > "admin"
  // (flair#1345 — these three sites used to hardcode the literal `admin`).
  const adminUser = resolveAdminUser(opts.adminUser);
  let authHeader: string | undefined;
  // Which tier supplied authHeader — drives the never-silent override notice
  // below (see describeIdentityOverride).
  let credSource: ResolvedCredentialSource | undefined;

  if (opts.signedOnly && opts.explicitAdminPass) {
    throw new Error(
      "refusing to send an admin password to a target that may receive only an Ed25519 signature or no Authorization header " +
        "(its instance is not proven); pass --agent <a registered agent id> instead",
    );
  }

  // Tier 1: explicit — caller-resolved flag material always wins.
  if (opts.explicitAdminPass) {
    authHeader = `Basic ${Buffer.from(`${adminUser}:${opts.explicitAdminPass}`).toString("base64")}`;
    credSource = "explicit-admin";
  } else if (opts.explicitKeyPath && opts.agentId) {
    try {
      authHeader = buildEd25519Auth(opts.agentId, method, signedPath, opts.explicitKeyPath);
      credSource = "explicit-key";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Ed25519 auth failed for agent '${opts.agentId}': ${message}`);
    }
  }

  // Tier 1.5: flag-pinned agent (flair#1500) — an --agent flag identity signs
  // as THAT agent BEFORE env admin. A flag-pinned agent with no key on disk is
  // a hard error (never a warning, never a silent substitution to env admin or
  // the local admin-pass file): the operator named a specific identity and the
  // CLI must not quietly sign as someone else.
  if (!authHeader && opts.agentIdSource === "flag" && opts.agentId) {
    const keyPath = resolveKeyPath(opts.agentId);
    if (!keyPath) {
      throw new Error(
        `--agent '${opts.agentId}' has no signing key. Expected a key at ` +
        `${join(defaultKeysDir(), `${opts.agentId}.key`)} (or set FLAIR_KEY_DIR ` +
        `to a directory containing it). Refusing to fall back to FLAIR_ADMIN_PASS ` +
        `or the local admin-pass file.`
      );
    }
    authHeader = buildEd25519Auth(opts.agentId, method, signedPath, keyPath);
    credSource = "flag-agent";
  }

  // Tier 2: env — FLAIR_TOKEN (Bearer), else FLAIR_ADMIN_PASS/HDB_ADMIN_PASSWORD (Basic).
  // Skipped when only a signature may be sent.
  if (!authHeader && !opts.signedOnly) {
    if (process.env.FLAIR_TOKEN) {
      authHeader = `Bearer ${process.env.FLAIR_TOKEN}`;
      credSource = "env-token";
    } else if (process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD) {
      const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD!;
      authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
      credSource = "env-admin";
    }
  }

  // Tier 3: a PINNED agent identity — sign specifically as this agent via
  // the standard key lookup (skipped if tier 1 already signed as this
  // agent via an explicit key path).
  if (!authHeader && opts.agentId) {
    const keyPath = resolveKeyPath(opts.agentId);
    if (keyPath) {
      try {
        authHeader = buildEd25519Auth(opts.agentId, method, signedPath, keyPath);
        credSource = "pinned-agent";
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Warning: Ed25519 auth failed for agent '${opts.agentId}': ${message}`);
      }
    }
  }

  // Tier 4: LOCAL TARGETS ONLY — the secure ~/.flair/admin-pass file.
  // Skipped when only a signature may be sent.
  if (!authHeader && !opts.signedOnly) {
    try {
      const filePass = resolveLocalAdminPass(undefined, !isLocal);
      if (filePass) {
        authHeader = `Basic ${Buffer.from(`${adminUser}:${filePass}`).toString("base64")}`;
        credSource = "local-admin-file";
      }
    } catch (err: unknown) {
      // File exists but has unsafe permissions — warn (never the secret
      // itself) and fall through to no-auth / the floor.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: ~/.flair/admin-pass unusable: ${message}`);
    }
  }

  // Never let a named identity (--agent flag or FLAIR_AGENT_ID env) be
  // silently outranked by a different credential. Precedence is unchanged
  // (see the section above describeIdentityOverride); only the silence is.
  if (opts.agentId && (opts.agentIdSource === "flag" || opts.agentIdSource === "env") && credSource) {
    const notice = describeIdentityOverride({
      agentId: opts.agentId,
      namedSource: opts.agentIdSource,
      credentialSource: credSource,
      adminPassEnvVar: process.env.FLAIR_ADMIN_PASS
        ? "FLAIR_ADMIN_PASS"
        : process.env.HDB_ADMIN_PASSWORD ? "HDB_ADMIN_PASSWORD" : undefined,
    });
    if (notice) emitIdentityOverrideNotice(notice);
  }

  // The last word for signedOnly: whatever resolved above, nothing but an
  // agent signature leaves (flair#2526).
  if (opts.signedOnly && authHeader !== undefined && !authHeader.startsWith(ED25519_SCHEME)) {
    throw new Error("refusing to send a Basic or Bearer credential to a target that may receive only an Ed25519 signature or no Authorization header");
  }

  try {
    return await sendJsonRequest(url, method, body, authHeader, isLocal, {
      refuseRedirects: opts.refuseRedirects,
      ...(opts.signedOnly ? { signedOnly: { agentId: opts.agentId, keysDir } } : {}),
    });
  } catch (err: unknown) {
    // Tier 5 — the floor. Only engages when NOTHING above resolved to
    // anything sendable (see module header for why a rejected credential
    // does not retry here).
    if (err instanceof ApiHttpError && err.noCredentials) {
      const floorResult = await tryAgentKeyFloor(url, method, body, keysDir, { refuseRedirects: opts.refuseRedirects });
      if (floorResult !== undefined) return floorResult;
    }
    throw err;
  }
}
