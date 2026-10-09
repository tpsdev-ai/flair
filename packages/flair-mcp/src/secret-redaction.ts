/**
 * Dependency-free credential redaction (flair#2067).
 *
 * Extracted verbatim from the pre-compaction record's redactor
 * (./precompact.ts) so a second consumer — the PreToolUse action-recall cache,
 * which stores memory excerpts on local disk — redacts with the SAME patterns
 * rather than a second, drifting copy. This module imports nothing: it must be
 * safe to load in a Bun entry point that has no client, no key and no network
 * (./action-recall-hook.ts).
 *
 * THE LINE-BREAK SET. An Authorization-style value is redacted up to the first
 * character of the set below and no further.
 */

/** What a redacted secret is replaced with. */
export const REDACTED = "[redacted]";

/**
 * Authorization-style values, redacted WHOLE: everything after the label or
 * scheme word through the end of its line, whatever its characters (a
 * credential can be any length and alphabet, and a scheme like Digest carries
 * quoted parameters). The line ends at the first character of the line-break
 * set below. The label or scheme word and one space stay; a value that is
 * already exactly the placeholder is left alone, so redacting twice changes
 * nothing. Applied before SECRET_PATTERNS:
 *   - an `Authorization` / `Proxy-Authorization` label (any case, then an
 *     optional quote and `:` or `=`), whatever scheme follows;
 *   - the scheme word `Bearer` (any case);
 *   - the scheme word `Basic` or `BASIC`. The lower-case word "basic" is
 *     ordinary English and is left alone unless an Authorization label
 *     precedes it.
 * Each pattern is a literal word, a bounded or single-class run, then the rest
 * of one line, so it stays linear on long input.
 */
export const AUTHORIZATION_PATTERNS: readonly RegExp[] = [
  /\b((?:proxy-)?authorization["']?[ \t]*[:=])([^\n\r\v\f\u0085\u2028\u2029]*)/gi,
  /\b(bearer)[ \t]+([^\n\r\v\f\u0085\u2028\u2029]*)/gi,
  /\b(Basic|BASIC)[ \t]+([^\n\r\v\f\u0085\u2028\u2029]*)/g,
];

/**
 * Credential shapes replaced in free text before it is stored or shown. They
 * cover the families the auto-capture filter in packages/pi-flair detects
 * (sk-, ghp_, pat_, Bearer, PEM private keys) and more. Best effort by design:
 * a secret with no recognizable shape (a bare password in prose, a random
 * string with no prefix) is NOT recognized. Every quantifier is bounded or
 * runs over a single character class, so no pattern backtracks badly on long
 * input.
 */
export const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private key blocks, whole, or to the end of the text when unterminated.
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----([\s\S]*?)(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED],
  // Credentials in a URL's userinfo: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}@/gi, `$1${REDACTED}@`],
  // name=value / name: value where the name says it is a credential.
  [
    /\b([A-Za-z0-9_.-]{0,40}(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,40})(\s{0,4}[:=]\s{0,4})("[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s"',;]{1,512})/gi,
    `$1$2${REDACTED}`,
  ],
  // Token shapes with a recognizable prefix.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, REDACTED], // OpenAI / Anthropic style keys
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED], // GitHub fine-grained PATs
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED], // GitLab PATs
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED], // Slack tokens
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED], // AWS access key ids
  [/\bAIza[A-Za-z0-9_-]{30,}/g, REDACTED], // Google API keys
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED], // npm tokens
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED], // Stripe secret/restricted keys
  [/\bhf_[A-Za-z0-9]{20,}/g, REDACTED], // Hugging Face tokens
  [/\bgsk_[A-Za-z0-9]{20,}/g, REDACTED], // Groq keys
  [/\bpypi-[A-Za-z0-9_-]{16,}/g, REDACTED], // PyPI tokens
  [/\bpat_[A-Za-z0-9_.-]{16,}/g, REDACTED], // generic PATs (pi-flair's pattern)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED], // JWTs
];

/** Replace every recognized credential shape in `text` with REDACTED. */
export function redactSecrets(text: string): string {
  return redactSecretsWithCount(text).text;
}

/**
 * Expand a `$1`-style replacement against a `String.replace` callback's
 * arguments (match, p1, p2, ...). The SECRET_PATTERNS replacements use only
 * `$1`/`$2`, so this reproduces their string-replacement form exactly.
 */
function expandReplacement(replacement: string, args: any[]): string {
  return replacement.replace(/\$(\d)/g, (_whole, digit: string) => String(args[Number(digit)] ?? ""));
}

/**
 * The same redaction as `redactSecrets`, plus the number of matched values
 * whose replacement differs from the matched text (flair#2407). A match that
 * is already in redacted form (e.g. `API_KEY=[redacted]`) is left as it is and
 * not counted. The server's explicit-Memory write paths use this so the write
 * response can report how many values were replaced.
 */
export function redactSecretsWithCount(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const pattern of AUTHORIZATION_PATTERNS) {
    out = out.replace(pattern, (whole: string, head: string, value: string) => {
      const v = value.trim();
      const replaced = v === "" || v === REDACTED ? whole : `${head} ${REDACTED}`;
      if (replaced !== whole) count += 1;
      return replaced;
    });
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args: any[]) => {
      const replaced = replacement === REDACTED ? REDACTED : expandReplacement(replacement, args);
      if (replaced !== args[0]) count += 1;
      return replaced;
    });
  }
  return { text: out, count };
}
