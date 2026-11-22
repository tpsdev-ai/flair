/**
 * Installer forms (flair#1834 PR-H), anchored so the full command must match. `<id>`, `<url>`
 * and `<ver>` are the only free variables; everything else — quoting, the
 * wrapper, `2>/dev/null`, ordering — is the shape Flair itself wrote.
 *
 * Literal regexes (no composed pattern): each form is a constant.
 * Capture groups: 1 = agent id, 2 = optional URL, 3 = the pinned package span.
 * The `d` flag exposes each group's OFFSET so the re-pin can substitute the
 * captured package span — never the first substring occurrence (round 2).
 *
 * Versions use digits and dots, with optional prerelease and build suffixes.
 * Separate groups admit both suffixes; excluding shell delimiters prevents
 * an attached command or expansion from matching this form.
 */
const HOOK_BARE_FORM_RE =
  /^FLAIR_AGENT_ID=([^\s'"$();|&<>]+)(?: FLAIR_URL=([^\s'"$();|&<>]+))? npx -y -p (@tpsdev-ai\/flair-mcp@\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) flair-session-start$/d;
const HOOK_CLAUDE_FORM_RE =
  /^sh -c 'out=\$\((?:FLAIR_ACTION_RECALL=1 )?FLAIR_AGENT_ID=([^\s'"$();|&<>]+)(?: FLAIR_URL=([^\s'"$();|&<>]+))? npx -y -p (@tpsdev-ai\/flair-mcp@\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) flair-session-start 2>\/dev\/null\) && printf %s "\$out" \|\| true'$/d;
const HOOK_CODEX_FORM_RE =
  /^sh -c 'out=\$\(FLAIR_HOOK_HARNESS=codex FLAIR_AGENT_ID=([^\s'"$();|&<>]+)(?: FLAIR_URL=([^\s'"$();|&<>]+))? npx -y -p (@tpsdev-ai\/flair-mcp@\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) flair-session-start\) && printf %s "\$out" \|\| true'$/d;

export interface InstallerHookForm {
  /** The form's harness (the bare form is harness-agnostic). */
  harness: "claude-code" | "codex";
  agentId: string;
  flairUrl?: string;
  /** [start, end) offset of the captured agent id within the FULL command. */
  agentIdStart: number;
  agentIdEnd: number;
  /** The captured package argument. */
  pkgSpec: string;
  /** [start, end) offset of `pkgSpec` within the FULL command (the re-pin span). */
  pkgSpecStart: number;
  pkgSpecEnd: number;
}

function formFromMatch(harness: "claude-code" | "codex", m: RegExpMatchArray): InstallerHookForm {
  const agentSpan = m.indices?.[1];
  const span = m.indices?.[3];
  if (!agentSpan || !span) throw new Error("installer hook form matched without group indices");
  return {
    harness,
    agentId: m[1]!,
    flairUrl: m[2],
    agentIdStart: agentSpan[0],
    agentIdEnd: agentSpan[1],
    pkgSpec: m[3]!,
    pkgSpecStart: span[0],
    pkgSpecEnd: span[1],
  };
}

/**
 * Match a full hook command against the installer forms, or null. This is
 * the strict replacement for the unanchored substring check: a duplicate
 * `FLAIR_AGENT_ID=`, an appended shell command, or an extra env var does not
 * match these forms.
 */
export function parseInstallerHookForm(command: string): InstallerHookForm | null {
  if (typeof command !== "string") return null;
  let m = command.match(HOOK_CLAUDE_FORM_RE);
  if (m) return formFromMatch("claude-code", m);
  m = command.match(HOOK_CODEX_FORM_RE);
  if (m) return formFromMatch("codex", m);
  m = command.match(HOOK_BARE_FORM_RE);
  if (m) return formFromMatch("claude-code", m);
  return null;
}

export function parseUnpinnedInstallerHookForm(command: string): Pick<InstallerHookForm, "agentId" | "flairUrl"> | null {
  if (!command.includes(" npx -y -p @tpsdev-ai/flair-mcp flair-session-start")) return null;
  const form = parseInstallerHookForm(command.replace(
    " npx -y -p @tpsdev-ai/flair-mcp flair-session-start",
    " npx -y -p @tpsdev-ai/flair-mcp@0.0.0 flair-session-start",
  ));
  return form ? { agentId: form.agentId, flairUrl: form.flairUrl } : null;
}
