/**
 * Tiny predicate evaluator for the YAML descriptor's `when:` clause.
 *
 * Slice 3a supports a deliberately small subset:
 *
 *   <field> in [<literal>, <literal>, ...]
 *   <field> == <literal>
 *   <field> != <literal>
 *
 * Where `<field>` is a `BridgeMemory`-shaped property name and `<literal>`
 * is a single-quoted or double-quoted string, a bare identifier (treated
 * as string), or a number/boolean. No nested expressions, no `&&`/`||`,
 * no parenthesization.
 *
 * Slice 3b will widen this to a real mini-grammar (probably JMESPath or
 * CEL or hand-rolled boolean operators). For now the goal is just to
 * support the agentic-stack reference adapter's
 *   when: "durability in ['persistent', 'permanent']"
 * cleanly without pulling in a dep.
 *
 * Returns null on unparsable input — caller decides whether to default
 * to true (always-export) or hard-fail.
 */

export type PredicateResult = "match" | "no-match" | "unparsable";

const FIELD_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+(in|==|!=)\s+(.+)$/;

export function evaluatePredicate(
  expression: string,
  record: Record<string, unknown>,
): PredicateResult {
  const trimmed = expression.trim();
  if (!trimmed) return "match"; // empty = always match

  const m = trimmed.match(FIELD_RE);
  if (!m) return "unparsable";
  const [, field, op, rhsRaw] = m;

  const lhs = record[field];

  if (op === "in") {
    const list = parseList(rhsRaw);
    if (list === null) return "unparsable";
    return list.some((v) => v === lhs) ? "match" : "no-match";
  }
  if (op === "==" || op === "!=") {
    const rhs = parseLiteral(rhsRaw.trim());
    if (rhs === undefined) return "unparsable";
    const eq = lhs === rhs;
    return (op === "==" ? eq : !eq) ? "match" : "no-match";
  }
  return "unparsable";
}

function parseList(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  // Split on commas, ignoring commas inside quoted strings. Slice 3a's
  // grammar doesn't allow quoted commas anyway; keep this naive.
  const parts = splitCsvRespectingQuotes(inner);
  const out: unknown[] = [];
  for (const p of parts) {
    const lit = parseLiteral(p.trim());
    if (lit === undefined) return null;
    out.push(lit);
  }
  return out;
}

function parseLiteral(raw: string): unknown {
  if (raw === "") return undefined;
  // Quoted string: single or double
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1);
  }
  // Boolean / null
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Bare identifier — treat as string. Allows: in [persistent, permanent]
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(raw)) return raw;
  return undefined;
}

function splitCsvRespectingQuotes(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      buf += c;
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; buf += c; continue; }
    if (c === "[" || c === "(") depth++;
    if (c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}
