- **`flair doctor --fix` no longer enables the opt-in continuity capture
  hooks.** On a clean install, `--fix` silently wired the PostToolUse + Stop
  `flair-continuity-capture` pair into `~/.claude/settings.json` — journaling
  every tool use and session stop without the opt-in doctor's own output says
  the feature requires (flair#1324; the non-TTY consent prompt auto-answered
  yes, so `--fix` alone was the trigger). Doctor's fixable set is broken
  state: enabling continuity is `flair hook install --continuity` only.
  `--fix` still repairs a partial or stale pair — evidence of a prior opt-in —
  to the complete current form, and `--dry-run` matches the new behavior. In
  the same consent family, `flair upgrade --check` no longer advises
  `flair doctor --fix` to re-pin an npx-wired flair-mcp: the pin refresh is
  `flair upgrade`'s own job, and it now also runs when a stale pin is the only
  pending change instead of bouncing the user to doctor.
