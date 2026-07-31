/**
 * dcr-gate.ts — who may register an OAuth client (RFC 7591 Dynamic Client
 * Registration) on flair's own authorization server.
 *
 * ── The state this replaces ─────────────────────────────────────────────────
 * `OAuthRegister.allowCreate()` returned `true` unconditionally and the only
 * gate in `post()` was a redirect-URI host match. On a publicly-reachable
 * instance that means anyone can create rows in `OAuthClient` — a durable,
 * replicated table — as fast as they can send requests, and every one of those
 * rows is a client_id that will subsequently be honoured by `/OAuthAuthorize`.
 *
 * ── Registration is now OFF unless an operator turns it on ──────────────────
 * `FLAIR_OAUTH_DCR_TOKEN` is the whole interface. Absent — which is every
 * install that has not deliberately opted in — `POST /OAuthRegister` refuses,
 * and `/OAuthMetadata` and `/.well-known/oauth-authorization-server` stop
 * advertising a `registration_endpoint`, because advertising one that refuses
 * everything is a discovery document that lies.
 *
 * ── Why ONE variable and not a mode enum ────────────────────────────────────
 * There is deliberately no `FLAIR_OAUTH_DCR=open`, and no way to enable
 * registration without also supplying the credential that guards it. Enabling
 * and crededentialling are the SAME ACT, so the "on, and open to the internet"
 * state is not reachable by forgetting an argument — it does not exist in the
 * configuration space at all. A mode enum plus an optional token would put that
 * state one typo away, and the difference between the two designs is only
 * visible on the day someone makes the typo.
 *
 * That is also why a token shorter than `MIN_INITIAL_ACCESS_TOKEN_LEN` disables
 * registration rather than enabling it weakly. A four-character shared secret on
 * an unauthenticated public endpoint is nearer to open than to closed, and a
 * control that silently degrades to almost-off is worse than one that is off,
 * because only one of the two is visible. The refusal is logged, by variable
 * NAME and minimum length — never the value.
 *
 * ── Why a header and not `Authorization: Bearer` ────────────────────────────
 * RFC 7591 s3.1 presents the initial access token as a Bearer token. That
 * channel does not work here, and this is measured rather than assumed: Harper's
 * own auth layer claims every `Authorization: Bearer ...` header for itself and
 * validates it as a Harper OPERATION token, so a Bearer-carrying request to
 * `/OAuthRegister` is answered `401 {"error":"invalid token"}` before any code
 * in resources/ runs. (Probed against a live instance: no header -> 200,
 * `Bearer <anything>` -> 401, custom header -> 200. Same mechanism documented in
 * resources/oauth-wellknown.ts's header for the REST surface.) So the token
 * arrives in `X-Flair-Initial-Access-Token`, which does reach the handler.
 *
 * ── This is not the same surface as flair#756's DCR removal ─────────────────
 * flair#756 disabled Dynamic Client Registration on the `@harperfast/oauth`
 * plugin's authorization server (`/oauth/mcp/register`) in favour of CIMD, and
 * deleted the gate-token machinery there. This module is about flair's OWN
 * OAuth 2.1 AS in resources/OAuth.ts, a separate endpoint that was left open.
 * The posture is the same one #756 settled on — registration is closed unless
 * an operator deliberately opens it — arrived at through the mechanism this
 * endpoint can actually support.
 */

import { timingSafeEqual } from "node:crypto";

/** The header the initial access token arrives in. See the module header. */
export const INITIAL_ACCESS_TOKEN_HEADER = "x-flair-initial-access-token";

/**
 * Shortest initial access token that will enable registration.
 *
 * The token guards an unauthenticated, publicly-reachable endpoint, so its only
 * defence is length. 32 characters of anything reasonable clears any offline
 * guessing concern; the per-IP rate limit on `/OAuthRegister` covers online
 * guessing. Anything shorter is refused outright rather than accepted weakly.
 */
export const MIN_INITIAL_ACCESS_TOKEN_LEN = 32;

/**
 * Longest accepted initial access token.
 *
 * A bound is needed because the constant-time comparison below works over
 * fixed-width buffers; it is set far above any plausible token (508 bytes is
 * ~15x a 32-byte base64 secret) so it constrains nothing real. A configured
 * value outside the range disables registration and says so, rather than
 * failing every comparison silently for a reason no operator could deduce.
 */
export const MAX_INITIAL_ACCESS_TOKEN_LEN = 508;

let warnedBadLength = false;

/** Test-only: forget the one-shot bad-length warning. */
export function __resetDcrWarningForTest(): void {
  warnedBadLength = false;
}

/**
 * The configured initial access token, or undefined when registration is off.
 *
 * Undefined covers all three of: variable unset, variable empty, and variable
 * too short to be a credential. Callers therefore cannot accidentally treat
 * "misconfigured" as "open" — there is one value that means enabled and it is a
 * usable token.
 */
export function initialAccessToken(): string | undefined {
  const raw = (process.env.FLAIR_OAUTH_DCR_TOKEN ?? "").trim();
  if (raw === "") return undefined;
  if (raw.length < MIN_INITIAL_ACCESS_TOKEN_LEN || Buffer.byteLength(raw, "utf8") > MAX_INITIAL_ACCESS_TOKEN_LEN) {
    if (!warnedBadLength) {
      warnedBadLength = true;
      console.error(
        `[oauth-dcr] FLAIR_OAUTH_DCR_TOKEN must be between ${MIN_INITIAL_ACCESS_TOKEN_LEN} and ` +
          `${MAX_INITIAL_ACCESS_TOKEN_LEN} characters — dynamic client registration stays DISABLED.`,
      );
    }
    return undefined;
  }
  return raw;
}

/** Is `POST /OAuthRegister` open for business on this instance? */
export function dcrEnabled(): boolean {
  return initialAccessToken() !== undefined;
}

/** Width of the comparison buffers: a 4-byte length prefix plus the token bytes. */
const COMPARE_WIDTH = MAX_INITIAL_ACCESS_TOKEN_LEN + 4;

/**
 * Encode a value into a fixed-width buffer as `<uint32 byte length><bytes><zero
 * padding>`, or null if it does not fit.
 *
 * The length prefix is what makes zero-padding safe. Padding alone would make
 * `"abc"` and `"abc\0"` compare equal, because both pad to the same bytes;
 * prefixing the length means two buffers are equal exactly when the two inputs
 * are the same length AND the same bytes.
 */
function fixedWidth(value: string): Buffer | null {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > MAX_INITIAL_ACCESS_TOKEN_LEN) return null;
  const buf = Buffer.alloc(COMPARE_WIDTH);
  buf.writeUInt32BE(bytes.length, 0);
  bytes.copy(buf, 4);
  return buf;
}

/**
 * Does the presented token match the configured one?
 *
 * Both values are widened to the same fixed-size buffer and compared with
 * `timingSafeEqual`. Equal width is not a convenience — it is the whole point:
 *
 *  - `timingSafeEqual` THROWS on a length mismatch, so handing it the raw values
 *    would turn the configured token's length into an oracle (throw vs. false).
 *  - `===` on strings short-circuits at the first differing byte, so it leaks a
 *    prefix match through timing.
 *
 * Fixed-width buffers remove both, and the comparison touches every byte of the
 * secret regardless of the input.
 *
 * DELIBERATELY NOT HASHED. An earlier revision digested both sides to get equal
 * lengths. That works, but a hash of a credential sitting in an equality check
 * reads — to a human and to a static analyser alike — as password-at-rest
 * storage, which invites the obvious "why isn't this a KDF" question. The honest
 * answer is that a KDF is the wrong primitive here: this is an equality check on
 * a high-entropy machine credential on an unauthenticated request path, so
 * deliberate per-request computational cost would be handing an attacker a
 * cheap amplification lever on the exact endpoint the rate limiter exists to
 * protect. Padding gets the same constant-time property with no hash to explain
 * and no cost to exploit.
 *
 * Returns false whenever registration is disabled, so a caller cannot reach the
 * comparison at all.
 */
export function initialAccessTokenMatches(presented: unknown): boolean {
  const expected = initialAccessToken();
  if (expected === undefined) return false;
  if (typeof presented !== "string" || presented === "") return false;
  const a = fixedWidth(presented);
  const b = fixedWidth(expected);
  // `b` cannot be null — initialAccessToken() already bounds the configured
  // value — but null-checking both keeps this total rather than relying on that
  // invariant holding in a future edit.
  if (a === null || b === null) return false;
  return timingSafeEqual(a, b);
}

/** Read the initial access token off a Harper request. Never logs it. */
export function presentedInitialAccessToken(request: any): string | undefined {
  const raw =
    request?.headers?.get?.(INITIAL_ACCESS_TOKEN_HEADER) ??
    request?.headers?.asObject?.[INITIAL_ACCESS_TOKEN_HEADER] ??
    undefined;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export type DcrDecision =
  /** Registration is switched off on this instance. */
  | { allowed: false; reason: "disabled" }
  /** Registration is on, but this request did not present the right token. */
  | { allowed: false; reason: "invalid_token" }
  | { allowed: true };

/**
 * The single decision point. `resources/OAuth.ts` calls this before it reads
 * ANYTHING else off the request — before the redirect-URI check, before any
 * write — so a caller who is not allowed to register learns nothing about the
 * server's registration policy beyond the fact that they may not.
 */
export function decideRegistration(request: any): DcrDecision {
  if (!dcrEnabled()) return { allowed: false, reason: "disabled" };
  if (!initialAccessTokenMatches(presentedInitialAccessToken(request))) {
    return { allowed: false, reason: "invalid_token" };
  }
  return { allowed: true };
}
