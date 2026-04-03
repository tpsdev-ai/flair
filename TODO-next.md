# Follow-up fixes

## No `flair start` command
Only `restart` (requires launchd service) and `init` exist. If Harper dies, there's no simple way to bring it back without re-running init. Add a `flair start` that starts Harper without reinstalling.

## Multiline paste bug in soul onboarding
Each newline in a pasted block submits a separate prompt answer, filling multiple soul fields with fragments of one answer. Options: detect rapid input and buffer, use a textarea-style prompt with explicit submit, or require empty line/Ctrl+D to submit.
