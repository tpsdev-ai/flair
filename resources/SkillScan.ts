import { Resource } from "harper";
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
 * Markdown is parsed before scanning (see `./scan/skill-markdown.ts`):
 *  - Well-formed inline code spans and fenced blocks are documentation
 *    for `shell_backtick`. Naming `npm create harper@latest` in a bullet
 *    is not a substitution the loader would execute.
 *  - Executable surfaces are YAML frontmatter, prose, and fail-closed
 *    leftovers (unclosed fences, unmatched backtick runs). `$(...)` on
 *    those surfaces is a substitution. A backtick pair in frontmatter is
 *    YAML legacy substitution, not markdown docs, and also fires
 *    `shell_backtick`.
 *  - Inline and fenced interiors still run the non-backtick detectors
 *    (exec/network/fs/encoding). Wrapping exec() in one backtick is not
 *    an exemption. A fence marker is not scanned. Unicode/homoglyph
 *    checks always run on the raw line.
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
