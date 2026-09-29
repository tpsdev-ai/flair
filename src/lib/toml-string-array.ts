/** A decoded TOML string and its exact source span, including quotes. */
export interface TomlStringSpan {
  value: string;
  start: number;
  end: number;
  quote: string;
}

/**
 * Read a TOML string array at `start`. Supports basic/literal strings, their
 * multiline forms, escapes, comments and trailing commas. This is deliberately
 * a value reader, not a table parser: callers establish the owning table and
 * reject duplicate keys/fences outside the captured value before writing.
 */
export function readTomlStringArray(text: string, start: number): { values: TomlStringSpan[]; end: number } | null {
  let i = start;
  function trivia(): void {
    for (;;) {
      while (/[ \t\r\n]/.test(text[i] ?? "!")) i++;
      if (text[i] !== "#") return;
      while (i < text.length && text[i] !== "\n") i++;
    }
  }
  function string(): TomlStringSpan | null {
    const start = i;
    const q = text[i];
    if (q !== '"' && q !== "'") return null;
    const multiline = text.startsWith(q.repeat(3), i);
    const quote = q.repeat(multiline ? 3 : 1);
    i += quote.length;
    if (multiline) {
      if (text.startsWith("\r\n", i)) i += 2;
      else if (text[i] === "\n") i++;
    }
    let value = "";
    while (i < text.length) {
      if (text.startsWith(quote, i)) {
        i += quote.length;
        // TOML permits one or two quote characters just before a multiline
        // closing delimiter (four/five consecutive quotes).
        if (multiline) {
          for (let n = 0; n < 2 && text[i] === q; n++, i++) value += q;
        }
        return { value, start, end: i, quote };
      }
      const ch = text[i++]!;
      if (ch === "\\" && q === '"') {
        if (multiline && /^[ \t]*(?:\r?\n)/.test(text.slice(i))) {
          while (/[ \t\r\n]/.test(text[i] ?? "!")) i++;
          continue;
        }
        const escape = text[i++];
        const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (escape !== undefined && simple[escape] !== undefined) value += simple[escape];
        else if (escape === "u" || escape === "U") {
          const length = escape === "u" ? 4 : 8;
          const hex = text.slice(i, i + length);
          if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) return null;
          const code = Number.parseInt(hex, 16);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
          value += String.fromCodePoint(code);
          i += length;
        } else return null;
      } else if (ch === "\r" && multiline && text[i] === "\n") {
        value += "\n";
        i++;
      } else {
        if (/[\x00-\x08\x0b-\x1f\x7f]/.test(ch) || (!multiline && ch === "\n")) return null;
        value += ch;
      }
    }
    return null;
  }
  trivia();
  if (text[i++] !== "[") return null;
  const values: TomlStringSpan[] = [];
  trivia();
  while (text[i] !== "]") {
    const value = string();
    if (!value) return null;
    values.push(value);
    trivia();
    if (text[i] === "]") break;
    if (text[i++] !== ",") return null;
    trivia();
  }
  i++;
  // No second value or command can trail the array on its assignment line.
  if (!/^[ \t]*(?:#.*)?(?:\r?\n|$)/.test(text.slice(i))) return null;
  return { values, end: i };
}
