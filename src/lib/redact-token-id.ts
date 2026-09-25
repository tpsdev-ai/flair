/**
 * redact-token-id.ts — the ONE pairing-token-id redactor (flair#1902).
 *
 * A pairing-token id IS the credential a spoke redeems, so only its 8-character
 * prefix may ever reach a log line. Three sites grew their own copy of this rule
 * in one day (the cleanup sweep's per-token lines, its table-level lines, and the
 * rollback reporter), so the class is fixed here rather than at each site: one
 * deep redactor every line that can carry a token id passes through.
 *
 * This is HYGIENE, not a security boundary — an operator holds admin credentials
 * and can read the table directly. But a token id printed in full in a log is a
 * credential handed to whoever reads the log, and the same gap reappearing at a
 * new site is the failure this module exists to end.
 *
 * What "deep" means: a string (a message OR a string field at any depth, an array
 * element, or an object KEY) has each secret replaced; numbers, booleans and null
 * pass through untouched; an object is rebuilt with redacted keys and values.
 * Object keys are redacted too — a `{ "<token-id>": ... }` map is exactly as much
 * a leak as one in a value.
 *
 * LENGTH GUARD: a secret shorter than MIN_SECRET_LENGTH characters is replaced by
 * "[redacted]" in full. Cutting an 11-character id to its 8-character prefix
 * leaves most of the id visible, which is not a redaction. Empty secrets are
 * ignored (never a replacement of "" that would splice the replacement between
 * every character).
 */

/** How many leading characters of a long secret are kept. */
export const TOKEN_ID_PREFIX_LENGTH = 8;

/**
 * Below this length, a secret is replaced in full: its "prefix" would be most of
 * it. Pairing-token ids are 32 characters (`randomBytes(24).toString("base64url")`),
 * so this bound is an untested assumption made explicit, not a live path — the
 * guard exists so a short id can never be printed whole by a prefix rule.
 */
export const MIN_SECRET_LENGTH = 12;

/** What a secret too short to prefix-cut becomes. */
export const FULLY_REDACTED = "[redacted]";

/** The replacement text for one secret. */
function replacementFor(secret: string): string {
  return secret.length < MIN_SECRET_LENGTH
    ? FULLY_REDACTED
    : `${secret.slice(0, TOKEN_ID_PREFIX_LENGTH)}…`;
}

/** Non-empty, non-short string secrets paired with their replacement, in order. */
function secretReplacements(secrets: readonly string[]): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      out.push([secret, replacementFor(secret)] as const);
    }
  }
  return out;
}

function redactString(text: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [secret, replacement] of replacements) {
    if (out.includes(secret)) out = out.split(secret).join(replacement);
  }
  return out;
}

function walk(value: unknown, replacements: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value === "string") return redactString(value, replacements);
  if (Array.isArray(value)) return value.map((v) => walk(v, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        redactString(key, replacements),
        walk(v, replacements),
      ]),
    );
  }
  // Numbers, booleans, null, undefined, functions, symbols: untouched.
  return value;
}

/**
 * A string with every secret replaced by its prefix (or `[redacted]` when the
 * secret is too short to cut). The string-only convenience over the same
 * implementation the deep redactor uses.
 */
export function redactTokenMessage(message: string, secrets: readonly string[]): string {
  return redactString(message, secretReplacements(secrets));
}

/**
 * `value` with every secret replaced in every string at any depth — a message, a
 * string field, an array element, and an object KEY — rebuilt so keys and values
 * are both redacted. Non-string scalars pass through untouched.
 */
export function redactTokenIds(value: unknown, secrets: readonly string[]): unknown {
  const replacements = secretReplacements(secrets);
  if (replacements.length === 0) return value;
  return walk(value, replacements);
}
