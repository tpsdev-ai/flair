import { Resource } from "harperdb";

/**
 * POST /SkillScan/
 *
 * Static analysis of skill content for security violations.
 * Scans for shell commands, network calls, fs writes, env access,
 * encoded payloads, zero-width chars, and homoglyphs.
 *
 * Request:  { content: string }
 * Response: { safe, violations, riskLevel }
 *
 * Auth: any authenticated agent (read-only analysis).
 * Size limit: 8KB (8192 bytes).
 */

interface Violation {
  type: string;
  line: number;
  content: string;
}

type RiskLevel = "low" | "medium" | "high" | "critical";

const SHELL_PATTERNS = [
  { regex: /\bexec\s*\(/, type: "shell_command" },
  { regex: /\bspawn\s*\(/, type: "shell_command" },
  { regex: /\bsystem\s*\(/, type: "shell_command" },
  { regex: /`[^`]*`/, type: "shell_backtick" },
  { regex: /\bchild_process\b/, type: "shell_command" },
];

const NETWORK_PATTERNS = [
  { regex: /\bfetch\s*\(/, type: "network_call" },
  { regex: /\bcurl\b/, type: "network_call" },
  { regex: /https?:\/\//, type: "url_reference" },
  { regex: /\bXMLHttpRequest\b/, type: "network_call" },
  { regex: /\baxios\b/, type: "network_call" },
];

const FS_PATTERNS = [
  { regex: /\bfs\.write/, type: "fs_write" },
  { regex: /\bwriteFile/, type: "fs_write" },
  { regex: />[>]?\s*[\/~]/, type: "fs_redirect" },
];

const ENV_PATTERNS = [
  { regex: /\bprocess\.env\b/, type: "env_access" },
  { regex: /\$ENV\b/, type: "env_access" },
  { regex: /\$\{?\w+\}?/, type: "env_variable" },
];

const ENCODING_PATTERNS = [
  { regex: /\batob\s*\(/, type: "base64_decode" },
  { regex: /\bbtoa\s*\(/, type: "base64_encode" },
  { regex: /Buffer\.from\s*\([^)]*,\s*['"]base64['"]/, type: "base64_decode" },
  { regex: /Buffer\.from\s*\([^)]*,\s*['"]hex['"]/, type: "hex_decode" },
  { regex: /\\x[0-9a-fA-F]{2}/, type: "hex_escape" },
  { regex: /\\u200[b-f]|\\u2060|\\ufeff/, type: "zero_width_char" },
];

// Unicode zero-width and homoglyph detection (raw chars)
const UNICODE_PATTERNS = [
  { regex: /[\u200B-\u200F\u2060\uFEFF]/, type: "zero_width_char" },
  { regex: /[\u0410-\u044F]/, type: "cyrillic_homoglyph" },  // Cyrillic chars that look like Latin
];

const ALL_PATTERNS = [
  ...SHELL_PATTERNS,
  ...NETWORK_PATTERNS,
  ...FS_PATTERNS,
  ...ENV_PATTERNS,
  ...ENCODING_PATTERNS,
  ...UNICODE_PATTERNS,
];

function assessRisk(violations: Violation[]): RiskLevel {
  if (violations.length === 0) return "low";

  const types = new Set(violations.map((v) => v.type));
  const hasShell = types.has("shell_command") || types.has("shell_backtick");
  const hasNetwork = types.has("network_call");
  const hasFs = types.has("fs_write") || types.has("fs_redirect");
  const hasZeroWidth = types.has("zero_width_char");
  const hasHomoglyph = types.has("cyrillic_homoglyph");

  // Critical: shell + encoding, or zero-width/homoglyph obfuscation
  if ((hasShell && (types.has("base64_decode") || types.has("hex_decode"))) ||
      hasZeroWidth || hasHomoglyph) {
    return "critical";
  }

  // High: direct shell commands or fs writes
  if (hasShell || hasFs) return "high";

  // Medium: network calls or encoding without shell
  if (hasNetwork || types.has("base64_decode") || types.has("hex_decode")) return "medium";

  return "low";
}

export class SkillScan extends Resource {
  async post(data: any, context?: any) {
    const { content } = data || {};

    if (!content || typeof content !== "string") {
      return new Response(
        JSON.stringify({ error: "content (string) required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // 8KB size limit
    const byteLength = new TextEncoder().encode(content).length;
    if (byteLength > 8192) {
      return new Response(
        JSON.stringify({ error: `Content exceeds 8KB limit (${byteLength} bytes)` }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }

    const lines = content.split("\n");
    const violations: Violation[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of ALL_PATTERNS) {
        if (pattern.regex.test(line)) {
          violations.push({
            type: pattern.type,
            line: i + 1,
            content: line.trim().slice(0, 200),
          });
        }
      }
    }

    const riskLevel = assessRisk(violations);

    return {
      safe: violations.length === 0,
      violations,
      riskLevel,
    };
  }
}
