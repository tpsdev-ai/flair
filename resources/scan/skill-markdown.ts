/**
 * Classify SKILL.md into scan regions before SkillScan runs.
 *
 * Well-formed markdown inline code and fenced blocks are documentation —
 * they are how a document *names* a command, not a substitution a loader
 * would execute. Frontmatter, prose, and unclosed/unmatched leftovers are
 * the executable surfaces (fail-closed when the parse is unsure).
 *
 * Pure module: no Harper runtime deps. Used by skill-scanner.ts and unit
 * tests.
 */

export type SpanKind =
  | "frontmatter"
  | "prose"
  | "inline_code"
  | "fenced_code"
  | "unclosed";

export interface MdSpan {
  kind: SpanKind;
  /** 1-based line number in the original document. */
  line: number;
  text: string;
  /** Fence info-string, when kind is fenced_code. */
  lang?: string;
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})([\w.-]*)[ \t]*$/;

export function isDocsSpan(kind: SpanKind): boolean {
  return kind === "inline_code" || kind === "fenced_code";
}

export function isExecutableSpan(kind: SpanKind): boolean {
  return kind === "frontmatter" || kind === "prose" || kind === "unclosed";
}

export function isFenceMarkerLine(text: string): boolean {
  return FENCE_RE.test(text);
}

/**
 * Split SKILL.md into classified spans. A line may produce several spans
 * (prose around inline code). Unclosed fences and unmatched backtick runs
 * are `unclosed` so the scanner can stay fail-closed.
 */
export function classifySkillMarkdown(content: string): MdSpan[] {
  const lines = content.split("\n");
  const spans: MdSpan[] = [];
  let i = 0;

  if (lines[0] === "---") {
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === "---") {
        end = j;
        break;
      }
    }
    if (end !== -1) {
      for (let j = 0; j <= end; j++) {
        spans.push({ kind: "frontmatter", line: j + 1, text: lines[j] ?? "" });
      }
      i = end + 1;
    }
  }

  let fence:
    | { char: string; len: number; lang: string; buf: MdSpan[] }
    | null = null;

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(FENCE_RE);
    if (m) {
      const marker = m[1] ?? "";
      const lang = (m[2] || "").toLowerCase();
      const char = marker[0] ?? "`";
      if (!fence) {
        fence = {
          char,
          len: marker.length,
          lang,
          buf: [{ kind: "fenced_code", line: i + 1, text: line, lang }],
        };
        continue;
      }
      // CommonMark: a closing fence is the same char, at least as long, and
      // has no info string.
      if (char === fence.char && marker.length >= fence.len && !lang) {
        spans.push(...fence.buf, {
          kind: "fenced_code",
          line: i + 1,
          text: line,
          lang: fence.lang,
        });
        fence = null;
        continue;
      }
    }
    if (fence) {
      fence.buf.push({
        kind: "fenced_code",
        line: i + 1,
        text: line,
        lang: fence.lang,
      });
      continue;
    }
    spans.push(...splitProseLine(line, i + 1));
  }

  if (fence) {
    // Unclosed fence: fail-closed — treat marker + body as executable.
    for (const s of fence.buf) s.kind = "unclosed";
    spans.push(...fence.buf);
  }

  return spans;
}

function splitProseLine(line: string, lineNo: number): MdSpan[] {
  const out: MdSpan[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let n = 0;
      while (i + n < line.length && line[i + n] === "`") n++;
      const close = findClosingBackticks(line, i + n, n);
      if (close === -1) {
        out.push({ kind: "unclosed", line: lineNo, text: line.slice(i) });
        return out;
      }
      out.push({
        kind: "inline_code",
        line: lineNo,
        text: line.slice(i, close + n),
      });
      i = close + n;
    } else {
      const next = line.indexOf("`", i);
      const end = next === -1 ? line.length : next;
      out.push({ kind: "prose", line: lineNo, text: line.slice(i, end) });
      i = end;
    }
  }
  if (out.length === 0) out.push({ kind: "prose", line: lineNo, text: line });
  return out;
}

function findClosingBackticks(line: string, from: number, n: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] === "`") {
      let m = 0;
      while (i + m < line.length && line[i + m] === "`") m++;
      if (m === n) return i;
      i += m;
    } else {
      i++;
    }
  }
  return -1;
}
