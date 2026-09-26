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
 * pass through untouched; a PLAIN object is rebuilt with redacted keys and values.
 * Object keys are redacted too — a `{ "<token-id>": ... }` map is exactly as much
 * a leak as one in a value. A NON-plain object — a Date, Error, Map, Set or class
 * instance — passes through unchanged: rebuilding it through `Object.entries`
 * would lose its message or entries, and its String form is what a caller should
 * log. A cyclic value terminates: a container already on the path is returned
 * as-is rather than recursed into (a log helper must never crash the sweep).
 *
 * Two properties the naive `split(secret).join(prefix)` gets wrong, and this
 * module gets right:
 *
 *   - LENGTH GUARD: a secret shorter than MIN_SECRET_LENGTH characters is
 *     replaced by "[redacted]" in full. Cutting an 11-character id to its
 *     8-character prefix leaves most of the id visible, which is not a redaction.
 *     Empty secrets are ignored (never a replacement of "" that would splice the
 *     replacement between every character).
 *   - ONE PASS, LONGEST FIRST: the secrets are matched in a SINGLE pass over the
 *     original text, longest secret first. Sequential replaces let a short secret
 *     that is a prefix of a longer one match first and strand the longer id's
 *     suffix — and let a later secret match inside text a previous replacement
 *     just inserted. A single left-to-right scan avoids both, and it deliberately
 *     does NOT build a RegExp: a pattern assembled from the secrets would run on
 *     caller-supplied text, and a ReDoS there is a worse failure than the leak.
 *
 * `createTokenRedactor(secrets)` compiles the matcher once; the sweep reuses one
 * per tick rather than rebuilding the replacement rules (or copying the id list)
 * for every line it logs.
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

/** Non-empty, de-duplicated secrets paired with their replacement, longest first. */
function secretReplacements(secrets: readonly string[]): Array<readonly [string, string]> {
  const seen = new Set<string>();
  const out: Array<readonly [string, string]> = [];
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    if (seen.has(secret)) continue;
    seen.add(secret);
    out.push([secret, replacementFor(secret)] as const);
  }
  // Longest-first: the scan takes the LONGEST secret that starts at a position,
  // so where two secrets overlap the longer one wins and no suffix of it is left
  // stranded by a shorter secret matching first.
  out.sort((a, b) => b[0].length - a[0].length);
  return out;
}

/** A compiled redactor: replace every secret in one pass, in any string. */
export interface TokenRedactor {
  redactMessage(message: string): string;
  redactValue(value: unknown): unknown;
}

/**
 * Compile `secrets` into a redactor. Build it ONCE for a batch of lines and reuse
 * it — the sweep logs many lines per tick, and recompiling per line is the
 * quadratic cost this avoids.
 *
 * The scan walks the ORIGINAL text once: at each position it takes the longest
 * secret that starts there (the list is longest-first), emits that secret's
 * replacement, and advances past it; otherwise it copies one character. Text a
 * replacement inserts is never re-scanned, and no RegExp is built from the
 * secrets (so a token id can never become a pattern).
 */
export function createTokenRedactor(secrets: readonly string[]): TokenRedactor {
  const replacements = secretReplacements(secrets);
  const redactMessage = (message: string): string => {
    if (replacements.length === 0 || message.length === 0) return message;
    let out = "";
    let i = 0;
    while (i < message.length) {
      let matched: readonly [string, string] | undefined;
      for (const pair of replacements) {
        if (message.startsWith(pair[0], i)) {
          matched = pair;
          break;
        }
      }
      if (matched) {
        out += matched[1];
        i += matched[0].length;
      } else {
        out += message[i];
        i += 1;
      }
    }
    return out;
  };
  return {
    redactMessage,
    redactValue: (value: unknown): unknown => (replacements.length === 0 ? value : walk(value, redactMessage)),
  };
}

function walk(value: unknown, redact: (text: string) => string): unknown {
  return walkDeep(value, redact, new Map<object, unknown>());
}

/**
 * A plain object: its prototype is `Object.prototype` or null. A Date, Error,
 * Map, Set or class instance is NOT a plain object, so it is not rebuilt — it
 * passes through UNREDACTED, and its String form is what a caller should log
 * (every call site stringifies an error before it reaches the redactor).
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rebuild `value` with every string redacted. `copies` maps each container
 * already rebuilt to its REDACTED copy, and the copy is registered before its
 * children are walked: a sub-object reached twice (an alias) is the same
 * redacted copy both times, and a cyclic value terminates by pointing at its own
 * redacted copy. Returning the original for a repeated reference would hand back
 * the unredacted container — the leak flair#1905's review found.
 */
function walkDeep(value: unknown, redact: (text: string) => string, copies: Map<object, unknown>): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    const known = copies.get(value);
    if (known !== undefined) return known;
    const out: unknown[] = [];
    copies.set(value, out);
    for (const v of value) out.push(walkDeep(v, redact, copies));
    return out;
  }
  if (value && typeof value === "object") {
    if (!isPlainObject(value)) return value;
    const known = copies.get(value);
    if (known !== undefined) return known;
    const out: Record<string, unknown> = {};
    copies.set(value, out);
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[redact(key)] = walkDeep(v, redact, copies);
    }
    return out;
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
  return createTokenRedactor(secrets).redactMessage(message);
}

/**
 * `value` with every secret replaced in every string at any depth — a message, a
 * string field, an array element, and an object KEY — rebuilt so keys and values
 * are both redacted. Non-string scalars pass through untouched.
 */
export function redactTokenIds(value: unknown, secrets: readonly string[]): unknown {
  return createTokenRedactor(secrets).redactValue(value);
}
