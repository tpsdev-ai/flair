import { Resource } from "@harperfast/harper";
import { allowVerified } from "./agent-auth.js";
import { scanSkillContent } from "./scan/skill-scanner.js";

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
 *
 * Scanner logic lives in `./scan/skill-scanner.ts` (pure module, no Harper
 * runtime deps) so unit tests can exercise it without instantiating the
 * Harper database.
 *
 * Markdown awareness:
 *  - Inline `single-token` backticks (markdown identifier convention) are NOT
 *    flagged. Only inline backticks whose content actually looks shell-ish
 *    (whitespace, pipe, semicolon, env-var, $(), &&, ||) fire shell_backtick.
 *  - Fenced ```code blocks``` with no language hint or a shell-family
 *    language (sh|bash|shell|zsh) are scanned for shell patterns. Non-shell
 *    language hints (json, yaml, ts, py, graphql, etc.) skip the shell
 *    patterns but keep network/fs/encoding/unicode detection active — those
 *    are language-agnostic attack surfaces.
 *  - This prevents the documentation-as-skill false-positive class without
 *    weakening detection on actual shell content.
 */

export class SkillScan extends Resource {
  /**
   * allowCreate()=allowVerified (authorizeLocal-escalation-class follow-up to
   * #601/#604/#609/#612 — flair#614's backstop found this resource had NO
   * allow* at all). The docstring above already says "Auth: any authenticated
   * agent" — this was never actually enforced; Harper's own default
   * (`user?.role.permission.super_user`, satisfiable only by a genuine admin
   * OR authorizeLocal's forged loopback super_user) silently stood in
   * instead. allowVerified matches the documented intent: any verified agent
   * (not admin-only — this is a stateless text scanner, no agent/memory data
   * touched), anonymous denied.
   */
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any, _context?: any) {
    const { content } = data || {};

    if (!content || typeof content !== "string") {
      return new Response(
        JSON.stringify({ error: "content (string) required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const byteLength = new TextEncoder().encode(content).length;
    if (byteLength > 8192) {
      return new Response(
        JSON.stringify({ error: `Content exceeds 8KB limit (${byteLength} bytes)` }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }

    return scanSkillContent(content);
  }
}
