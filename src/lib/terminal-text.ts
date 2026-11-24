/**
 * terminal-text.ts — escape six Unicode categories in a dynamic fragment
 * before it is printed to a terminal.
 *
 * A stored value (an Agent id, a Soul key, an embedding-model name, a
 * federation field, a server warning) is data, not layout. Printed raw, a
 * control character can move the cursor or erase a line, and a bidi override
 * can reorder one so the row reads differently from the bytes. This renders
 * such a value for a HUMAN: a code point in control (Cc), format (Cf,
 * including bidi overrides), surrogate (Cs), unassigned (Cn), line separator
 * (Zl) or paragraph separator (Zp) is shown as a visible `\u{...}` escape, and
 * every other code point is unchanged.
 *
 * This is display only: callers keep the stored value for JSON output and
 * request bodies, so those stay byte-identical. It deliberately does not
 * reuse boundServerText (auth-resolve.ts), which collapses whitespace and
 * truncates — either would change an id's spelling.
 */
const ESCAPED_CATEGORIES = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u;

export function escapeTerminalText(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ESCAPED_CATEGORIES.test(ch)) {
      const cp = ch.codePointAt(0) ?? 0;
      out += `\\u{${cp.toString(16).padStart(2, "0")}}`;
    } else {
      out += ch;
    }
  }
  return out;
}
