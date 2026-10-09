- **`flair hook install --capture` wires Claude Code PostToolUseFailure, PostToolUse and Stop hooks that stage command follow-ups and cue-matching sentences as candidate memories (flair#2068).**

  The hook may redact a candidate and append it to a bounded, private spool under
  `~/.flair/capture/`. Network writes run in a detached flush; a candidate may
  wait or be evicted before a write. Install probes the provisioned copy; status
  probes the artifact path named in settings.
  Partial or stale capture status exits nonzero with `--capture`.

  > **Heads-up:** the hook is copied to `~/.flair/hooks/capture/<version>-<hash>/`
  > at install time. Re-run the installation after upgrading `@tpsdev-ai/flair`
  > so the copy matches the running version.
