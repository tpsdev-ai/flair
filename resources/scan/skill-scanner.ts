/**
 * Skill content static analyzer — pure, no Harper runtime deps.
 *
 * Imported by `resources/SkillScan.ts` (the HTTP Resource) and by unit
 * tests in `test/unit/SkillScan.test.ts`. Keeping the scanner logic in a
 * separate module lets the tests run without instantiating the Harper
 * runtime.
 *
 * See SkillScan.ts for the design rationale on markdown awareness and the
 * language-agnostic vs shell-only pattern split.
 */

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

const LANG_AGNOSTIC_PATTERNS: Pattern[] = [
  ...NETWORK_PATTERNS,
  ...FS_PATTERNS,
  ...ENV_PATTERNS,
  ...ENCODING_PATTERNS,
  ...UNICODE_PATTERNS,
];

const SHELL_FENCE_LANGS = new Set(["", "sh", "bash", "shell", "zsh"]);
const MARKDOWN_IDENTIFIER_RE = /^[\w@./-]+$/;

const SHELL_BACKTICK_INDICATORS = [
  /\s/,
  /[|;&]/,
  /\$\(/,
  /\$\{/,
  /^\$\w/,
  />/,
  /<\(/,
];

function lineHasShellishBacktick(line: string): boolean {
  const matches = line.match(/`([^`\n]+)`/g);
  if (!matches) return false;
  for (const raw of matches) {
    const inner = raw.slice(1, -1);
    if (MARKDOWN_IDENTIFIER_RE.test(inner)) continue;
    for (const indicator of SHELL_BACKTICK_INDICATORS) {
      if (indicator.test(inner)) return true;
    }
  }
  return false;
}

function assessRisk(violations: Violation[]): RiskLevel {
  if (violations.length === 0) return "low";

  const types = new Set(violations.map((v) => v.type));
  // Programmatic shell call patterns: exec/spawn/system/child_process. These
  // are definite payloads when they appear in a skill.
  const hasShellCommand = types.has("shell_command");
  // Backticked shell-ish content in markdown prose. Could be `npm run deploy`
  // in documentation (medium), or could combine with other smells (high).
  const hasShellBacktick = types.has("shell_backtick");
  const hasFs = types.has("fs_write") || types.has("fs_redirect");
  const hasEncoding = types.has("base64_decode") || types.has("hex_decode");
  const hasZeroWidth = types.has("zero_width_char");
  const hasHomoglyph = types.has("cyrillic_homoglyph");

  // Critical: any shell combined with encoded payloads, OR obfuscation chars.
  if (
    ((hasShellCommand || hasShellBacktick) && hasEncoding) ||
    hasZeroWidth ||
    hasHomoglyph
  ) {
    return "critical";
  }

  // High: programmatic shell, fs writes, or shell-backtick + other smells
  // (env access, network call). A skill that quotes a command AND reads env
  // AND fetches a URL is doing something, not just documenting.
  const hasOtherSmells =
    types.has("env_access") ||
    types.has("env_variable") ||
    types.has("network_call") ||
    types.has("url_reference");
  if (hasShellCommand || hasFs || (hasShellBacktick && hasOtherSmells)) {
    return "high";
  }

  // Medium: shell_backtick alone (doc reference), or network/encoding
  // without shell. Reviewable but not blocked.
  if (hasShellBacktick || hasOtherSmells || hasEncoding) {
    return "medium";
  }

  return "low";
}

interface FenceState {
  inFence: boolean;
  lang: string;
}

function detectFenceTransition(line: string, state: FenceState): boolean {
  const m = line.match(/^[ \t]*```([\w.-]*)\s*$/);
  if (!m) return false;
  if (state.inFence) {
    state.inFence = false;
    state.lang = "";
  } else {
    state.inFence = true;
    state.lang = (m[1] || "").toLowerCase();
  }
  return true;
}

export function scanSkillContent(content: string): ScanResult {
  const lines = content.split("\n");
  const violations: Violation[] = [];
  const fence: FenceState = { inFence: false, lang: "" };

  const recordIfMatch = (lineIndex: number, line: string, patterns: Pattern[]) => {
    for (const pattern of patterns) {
      if (pattern.regex.test(line)) {
        violations.push({
          type: pattern.type,
          line: lineIndex + 1,
          content: line.trim().slice(0, 200),
        });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (detectFenceTransition(line, fence)) continue;

    const insideShellFence = fence.inFence && SHELL_FENCE_LANGS.has(fence.lang);
    const insideNonShellFence = fence.inFence && !insideShellFence;

    if (!fence.inFence && lineHasShellishBacktick(line)) {
      violations.push({
        type: "shell_backtick",
        line: i + 1,
        content: line.trim().slice(0, 200),
      });
    }

    if (!insideNonShellFence) {
      recordIfMatch(i, line, SHELL_PATTERNS);
    }

    recordIfMatch(i, line, LANG_AGNOSTIC_PATTERNS);
  }

  const riskLevel = assessRisk(violations);
  return { safe: violations.length === 0, violations, riskLevel };
}
