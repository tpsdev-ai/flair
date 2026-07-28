/**
 * XML entity escaping for the launchd plists this CLI generates.
 *
 * A launchd plist is XML, so ANY value interpolated into one has to be
 * escaped or the document is malformed — and `launchctl load` rejects a
 * malformed plist outright, so the service silently never registers.
 *
 * Two independent writers generate plists, and both go through here:
 *   - buildLaunchdPlist() in src/cli.ts (the Harper service, `flair init`)
 *   - renderPlistTemplate() in src/rem/scheduler.ts (`flair rem nightly enable`)
 *
 * This module exists so there is exactly ONE implementation to get right.
 * Anything that interpolates into plist XML imports it rather than
 * hand-rolling a `.replace()` chain at the call site — a local chain is how
 * this class of bug got in (and how it stayed partial: the original one
 * covered three of the five entities).
 */

/** The five XML predefined entities, in the order they must be replaced. */
const XML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // `&` MUST be first: replacing it after `<` would turn the `&` of an
  // already-emitted `&lt;` into `&amp;lt;` and corrupt the value.
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/'/g, "&apos;"],
];

/**
 * Escape the five XML predefined entities for use inside an XML text node.
 *
 * Safe to apply to any string, including one with no special characters.
 * The result round-trips exactly through unescapeXml().
 */
export function escapeXml(s: string): string {
  let out = s;
  for (const [pattern, replacement] of XML_ESCAPES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Inverse of escapeXml(), for reading a value back out of a document we wrote.
 *
 * `&amp;` MUST be decoded LAST, mirroring escapeXml()'s ordering: decoding it
 * first would turn `&amp;lt;` (the escaping of a literal "&lt;") into `<`
 * instead of back into `&lt;`.
 */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
