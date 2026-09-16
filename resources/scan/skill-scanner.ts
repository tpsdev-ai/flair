/**
 * Skill content static analyzer — pure, no Harper runtime deps.
 *
 * Imported by `resources/SkillScan.ts` (the HTTP Resource) and by unit
 * tests in `test/unit/SkillScan.test.ts`. Keeping the scanner logic in a
 * separate module lets the tests run without instantiating the Harper
 * runtime.
 *
 * Markdown is classified first (`./skill-markdown.ts`). Well-formed inline
 * code and fenced blocks are documentation for `shell_backtick` — naming
 * a command is not a substitution. The scanner still runs the non-backtick
 * detectors (exec/fetch/writeFile/encoding) on inline and fenced interiors,
 * because wrapping `exec(...)` in one backtick does not stop it being a
 * payload. Prose, YAML frontmatter, and unclosed leftovers are fully
 * scanned. Unicode/homoglyphs always run on the raw line.
 *
 * `shell_backtick` means a substitution the loader would see (`$(...)` in
 * an executable surface, or an unmatched backtick run). It does not mean
 * "this line contains a markdown code span."
 */

import {
  classifySkillMarkdown,
  isExecutableSpan,
  isFenceMarkerLine,
  type MdSpan,
} from "./skill-markdown.js";

export interface Violation {
  type: string;
  line: number;
  content: string;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ScanResult {
  safe: boolean;
  violations: Violation[];
  riskLevel: RiskLevel;
}

interface Pattern {
  regex: RegExp;
  type: string;
}

const SHELL_PATTERNS: Pattern[] = [
  { regex: /\bexec\s*\(/, type: "shell_command" },
  { regex: /\bspawn\s*\(/, type: "shell_command" },
  { regex: /\bsystem\s*\(/, type: "shell_command" },
  { regex: /\bchild_process\b/, type: "shell_command" },
];

const NETWORK_PATTERNS: Pattern[] = [
  { regex: /\bfetch\s*\(/, type: "network_call" },
  { regex: /\bcurl\b/, type: "network_call" },
  { regex: /https?:\/\//, type: "url_reference" },
  { regex: /\bXMLHttpRequest\b/, type: "network_call" },
  { regex: /\baxios\b/, type: "network_call" },
];

const FS_PATTERNS: Pattern[] = [
  { regex: /\bfs\.write/, type: "fs_write" },
  { regex: /\bwriteFile/, type: "fs_write" },
  { regex: />[>]?\s*[\/~]/, type: "fs_redirect" },
];

const ENV_PATTERNS: Pattern[] = [
  { regex: /\bprocess\.env\b/, type: "env_access" },
  { regex: /\$ENV\b/, type: "env_access" },
  { regex: /\$\{?\w+\}?/, type: "env_variable" },
];

const ENCODING_PATTERNS: Pattern[] = [
  { regex: /\batob\s*\(/, type: "base64_decode" },
  { regex: /\bbtoa\s*\(/, type: "base64_encode" },
  { regex: /Buffer\.from\s*\([^)]*,\s*['"]base64['"]/, type: "base64_decode" },
  { regex: /Buffer\.from\s*\([^)]*,\s*['"]hex['"]/, type: "hex_decode" },
  { regex: /\\x[0-9a-fA-F]{2}/, type: "hex_escape" },
  { regex: /\\u200[b-f]|\\u2060|\\ufeff/, type: "zero_width_char" },
];

const UNICODE_PATTERNS: Pattern[] = [
  { regex: /[​-‏⁠﻿]/, type: "zero_width_char" },
  { regex: /[А-я]/, type: "cyrillic_homoglyph" },
];

/** Network, fs, env, and encoding. Unicode always scans the raw line. */
const CONTENT_HAZARD_PATTERNS: Pattern[] = [
  ...NETWORK_PATTERNS,
  ...FS_PATTERNS,
  ...ENV_PATTERNS,
  ...ENCODING_PATTERNS,
];

const SHELL_FENCE_LANGS = new Set(["", "sh", "bash", "shell", "zsh"]);

export function assessRisk(violations: Violation[]): RiskLevel {
  if (violations.length === 0) return "low";

  const types = new Set(violations.map((v) => v.type));
  const hasShellCommand = types.has("shell_command");
  // shell_backtick is a substitution on an executable surface, not a
  // markdown code span. Alone it is still reviewable; with other smells
  // it is a payload.
  const hasShellBacktick = types.has("shell_backtick");
  const hasFs = types.has("fs_write") || types.has("fs_redirect");
  const hasEncoding = types.has("base64_decode") || types.has("hex_decode");
  const hasZeroWidth = types.has("zero_width_char");
  const hasHomoglyph = types.has("cyrillic_homoglyph");

  if (
    ((hasShellCommand || hasShellBacktick) && hasEncoding) ||
    hasZeroWidth ||
    hasHomoglyph
  ) {
    return "critical";
  }

  const hasOtherSmells =
    types.has("env_access") ||
    types.has("env_variable") ||
    types.has("network_call") ||
    types.has("url_reference");
  if (hasShellCommand || hasFs || (hasShellBacktick && hasOtherSmells)) {
    return "high";
  }

  if (hasShellBacktick || hasOtherSmells || hasEncoding) {
    return "medium";
  }

  return "low";
}

function executableText(spans: MdSpan[]): string {
  return spans.filter((s) => isExecutableSpan(s.kind)).map((s) => s.text).join("");
}

function hasCommandSubstitution(text: string): boolean {
  return /\$\(/.test(text);
}

export function scanSkillContent(content: string): ScanResult {
  const lines = content.split("\n");
  const spans = classifySkillMarkdown(content);
  const violations: Violation[] = [];

  const recordIfMatch = (lineIndex: number, text: string, patterns: Pattern[]) => {
    const original = (lines[lineIndex] ?? "").trim().slice(0, 200);
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        violations.push({
          type: pattern.type,
          line: lineIndex + 1,
          content: original || text.trim().slice(0, 200),
        });
      }
    }
  };

  // Obfuscation is never "documentation format" — scan the raw line.
  for (let i = 0; i < lines.length; i++) {
    recordIfMatch(i, lines[i] ?? "", UNICODE_PATTERNS);
  }

  const byLine = new Map<number, MdSpan[]>();
  for (const span of spans) {
    const list = byLine.get(span.line) ?? [];
    list.push(span);
    byLine.set(span.line, list);
  }

  for (const [lineNo, lineSpans] of byLine) {
    const lineIndex = lineNo - 1;
    const allFence = lineSpans.every((s) => s.kind === "fenced_code");
    const rawLine = lineSpans[0]?.text ?? "";

    if (allFence && isFenceMarkerLine(rawLine)) continue;

    if (allFence) {
      const lang = lineSpans[0]?.lang ?? "";
      const text = lineSpans.map((s) => s.text).join("");
      if (SHELL_FENCE_LANGS.has(lang)) {
        recordIfMatch(lineIndex, text, SHELL_PATTERNS);
      }
      recordIfMatch(lineIndex, text, CONTENT_HAZARD_PATTERNS);
      continue;
    }

    const exec = executableText(lineSpans);
    const inline = lineSpans
      .filter((s) => s.kind === "inline_code")
      .map((s) => s.text)
      .join("");
    const hasUnclosed = lineSpans.some((s) => s.kind === "unclosed");
    // shell_backtick is format-vs-hazard: only unclosed runs and $(...) on
    // executable surfaces. A named command in a well-formed span is docs.
    if (hasUnclosed || hasCommandSubstitution(exec)) {
      violations.push({
        type: "shell_backtick",
        line: lineNo,
        content: (lines[lineIndex] ?? "").trim().slice(0, 200),
      });
    }
    recordIfMatch(lineIndex, exec, SHELL_PATTERNS);
    recordIfMatch(lineIndex, exec, CONTENT_HAZARD_PATTERNS);
    // Inline interiors get the same non-backtick detectors as fenced
    // interiors. One backtick around exec() is not a documentation exemption.
    recordIfMatch(lineIndex, inline, SHELL_PATTERNS);
    recordIfMatch(lineIndex, inline, CONTENT_HAZARD_PATTERNS);
  }

  const riskLevel = assessRisk(violations);
  return { safe: violations.length === 0, violations, riskLevel };
}

/**
 * Merge independently-scanned parts (trigger, content) and re-apply the
 * combinatorial risk rules. Parsing separately stops a crafted prefix
 * from stealing frontmatter; assessing the union keeps
 * `shell_backtick` + URL / encoding across fields at high/critical.
 */
export function combineScanResults(scans: ScanResult[]): ScanResult {
  const violations = scans.flatMap((s) => s.violations);
  const riskLevel = assessRisk(violations);
  return { safe: violations.length === 0, violations, riskLevel };
}
