/**
 * gha-expression.ts — evaluate GitHub Actions expressions in tests, so a
 * workflow test can ask what a job condition, a matrix or an env binding
 * resolves to for one event, instead of matching the expression's text.
 *
 * Supported: string ('' escapes a quote), number, boolean and null literals;
 * dotted and indexed property paths (an absent property is null); `!`, `==`,
 * `!=`, `&&` and `||` (which return an operand and do not evaluate the one
 * they skip); parentheses; and startsWith, endsWith, contains, format,
 * fromJSON, toJSON, always, success, failure and cancelled. Operators and
 * brackets inside string literals are text. The status functions read the
 * `needs` results in the context: success() is true when no needed job has a
 * result other than success, failure() when one failed. Anything else,
 * hashFiles() included, throws when a test evaluates it.
 */

export type Context = Record<string, unknown>;

type Token = { kind: "str" | "num" | "ident" | "op" | "punc"; text: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let text = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string in: ${src}`);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { text += "'"; i += 2; continue; }
          i++;
          break;
        }
        text += src[i++];
      }
      tokens.push({ kind: "str", text });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "&&" || two === "||") { tokens.push({ kind: "op", text: two }); i += 2; continue; }
    if (c === "!") { tokens.push({ kind: "op", text: c }); i++; continue; }
    if ("().,[]".includes(c)) { tokens.push({ kind: "punc", text: c }); i++; continue; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { tokens.push({ kind: "num", text: num[0] }); i += num[0].length; continue; }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (ident) { tokens.push({ kind: "ident", text: ident[0] }); i += ident[0].length; continue; }
    throw new Error(`unsupported character '${c}' in: ${src}`);
  }
  return tokens;
}

const isNullish = (v: unknown) => v === null || v === undefined;

export function truthy(v: unknown): boolean {
  return !(v === false || v === 0 || v === "" || isNullish(v) || (typeof v === "number" && Number.isNaN(v)));
}

function toNumber(v: unknown): number {
  if (isNullish(v)) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return Number.NaN;
}

/** GitHub's loose equality: strings compare case-insensitively, mixed types as numbers. */
function looseEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (isNullish(a) && isNullish(b)) return true;
  if (typeof a === "object" && a !== null) return a === b;
  if (typeof b === "object" && b !== null) return false;
  return toNumber(a) === toNumber(b);
}

export function toText(v: unknown): string {
  if (isNullish(v)) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  startswith: (a, b) => toText(a).toLowerCase().startsWith(toText(b).toLowerCase()),
  endswith: (a, b) => toText(a).toLowerCase().endsWith(toText(b).toLowerCase()),
  contains: (a, b) =>
    Array.isArray(a) ? a.some((item) => looseEqual(item, b)) : toText(a).toLowerCase().includes(toText(b).toLowerCase()),
  format: (fmt, ...args) => toText(fmt).replace(/\{(\d+)\}/g, (_, n: string) => toText(args[Number(n)])),
  fromjson: (s) => JSON.parse(toText(s)),
  tojson: (v) => JSON.stringify(v, null, 2),
};

/** The status functions, which read the needed jobs' results from the context. */
function needResults(ctx: Context): unknown[] {
  const needs = ctx.needs;
  if (needs === null || typeof needs !== "object") return [];
  return Object.values(needs as Record<string, unknown>).map((need) =>
    need !== null && typeof need === "object" ? (need as { result?: unknown }).result ?? "success" : "success");
}
const STATUS_FUNCTIONS: Record<string, (ctx: Context) => boolean> = {
  always: () => true,
  success: (ctx) => needResults(ctx).every((result) => result === "success"),
  failure: (ctx) => needResults(ctx).some((result) => result === "failure"),
  cancelled: (ctx) => needResults(ctx).some((result) => result === "cancelled"),
};

class Parser {
  private pos = 0;
  /** Set when the expression calls a status function (a call token, not text inside a string). */
  statusCalled = false;
  /** False while parsing an operand that && or || does not evaluate: it is parsed, not run. */
  private active = true;
  constructor(private readonly tokens: Token[], private readonly ctx: Context, private readonly src: string) {}

  parse(): unknown {
    const value = this.or();
    if (this.pos !== this.tokens.length) throw new Error(`unexpected '${this.tokens[this.pos].text}' in: ${this.src}`);
    return value;
  }

  /** The next token; with `text`, only an operator or punctuation token with that text (never a string). */
  private peek(text?: string): Token | undefined {
    const t = this.tokens[this.pos];
    if (!t) return undefined;
    if (text === undefined) return t;
    return (t.kind === "op" || t.kind === "punc") && t.text === text ? t : undefined;
  }

  /** Parse an operand that is not evaluated (short-circuit): its syntax and status calls still count. */
  private skip(parse: () => unknown): void {
    const saved = this.active;
    this.active = false;
    try { parse(); } finally { this.active = saved; }
  }

  private expect(text: string): void {
    if (!this.peek(text)) throw new Error(`expected '${text}' in: ${this.src}`);
    this.pos++;
  }

  private or(): unknown {
    let left = this.and();
    while (this.peek("||")) {
      this.pos++;
      if (truthy(left)) this.skip(() => this.and());
      else left = this.and();
    }
    return left;
  }

  private and(): unknown {
    let left = this.equality();
    while (this.peek("&&")) {
      this.pos++;
      if (!truthy(left)) this.skip(() => this.equality());
      else left = this.equality();
    }
    return left;
  }

  private equality(): unknown {
    let left = this.unary();
    for (;;) {
      if (this.peek("==")) { this.pos++; left = looseEqual(left, this.unary()); continue; }
      if (this.peek("!=")) { this.pos++; left = !looseEqual(left, this.unary()); continue; }
      return left;
    }
  }

  private unary(): unknown {
    if (this.peek("!")) { this.pos++; return !truthy(this.unary()); }
    return this.postfix(this.primary());
  }

  private primary(): unknown {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error(`unexpected end of: ${this.src}`);
    if (t.kind === "str") return t.text;
    if (t.kind === "num") return Number(t.text);
    if (t.kind === "punc" && t.text === "(") { const v = this.or(); this.expect(")"); return v; }
    if (t.kind !== "ident") throw new Error(`unexpected '${t.text}' in: ${this.src}`);
    if (t.text === "true") return true;
    if (t.text === "false") return false;
    if (t.text === "null") return null;
    if (this.peek("(")) {
      const status = STATUS_FUNCTIONS[t.text.toLowerCase()];
      if (status) { this.pos++; this.expect(")"); this.statusCalled = true; return this.active ? status(this.ctx) : null; }
      const fn = FUNCTIONS[t.text.toLowerCase()];
      if (!fn) throw new Error(`unsupported function ${t.text}() in: ${this.src}`);
      this.pos++;
      const args: unknown[] = [];
      if (!this.peek(")")) {
        for (;;) { args.push(this.or()); if (this.peek(",")) { this.pos++; continue; } break; }
      }
      this.expect(")");
      return this.active ? fn(...args) : null;
    }
    return Object.hasOwn(this.ctx, t.text) ? this.ctx[t.text] : null;
  }

  private postfix(value: unknown): unknown {
    for (;;) {
      if (this.peek(".")) {
        this.pos++;
        const name = this.tokens[this.pos++];
        if (!name || name.kind !== "ident") throw new Error(`expected a property name in: ${this.src}`);
        value = property(value, name.text);
        continue;
      }
      if (this.peek("[")) {
        this.pos++;
        const key = this.or();
        this.expect("]");
        value = property(value, key);
        continue;
      }
      return value;
    }
  }
}

function property(value: unknown, key: unknown): unknown {
  if (value === null || typeof value !== "object") return null;
  const k = toText(key);
  return Object.hasOwn(value, k) ? (value as Record<string, unknown>)[k] : null;
}

/** Evaluate one expression body (the text inside `${{ }}`, or a bare `if:`). */
export function evaluate(expression: string, ctx: Context): unknown {
  return new Parser(tokenize(expression), ctx, expression).parse();
}

/** A workflow value: a single `${{ }}` yields its value; text with several interpolates them. */
export function evaluateValue(value: unknown, ctx: Context): unknown {
  if (typeof value !== "string" || !value.includes("${{")) return value;
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(value);
  if (whole && !whole[1].includes("${{")) return evaluate(whole[1], ctx);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, body: string) => toText(evaluate(body, ctx)));
}

/**
 * A job or step `if:`. A condition that calls no status function (always(),
 * success(), failure() or cancelled(), as call tokens; the same text inside a
 * string literal does not count) is evaluated as `success() && (condition)`,
 * and an absent one as `success()`.
 */
export function evaluateIf(condition: unknown, ctx: Context): boolean {
  if (condition === undefined) return STATUS_FUNCTIONS.success(ctx);
  if (typeof condition === "boolean") return STATUS_FUNCTIONS.success(ctx) && condition;
  const text = String(condition);
  const wrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text);
  const body = wrapped ? wrapped[1] : text;
  const parser = new Parser(tokenize(body), ctx, body);
  const value = truthy(parser.parse());
  return parser.statusCalled ? value : STATUS_FUNCTIONS.success(ctx) && value;
}
