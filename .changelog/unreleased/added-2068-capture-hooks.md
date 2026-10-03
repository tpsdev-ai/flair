- **`flair hook install --capture` wires Claude Code PostToolUse + Stop hooks that capture a failed command with its fix, and stated decisions, as memories (flair#2068).**

  The hook redacts one candidate, appends it to a bounded, private spool under
  `~/.flair/capture/`, and returns without a network call; a detached background
  flush writes it through Flair's normal path, so the agent never waits on it.
  Install and status probe the provisioned copy; uninstall removes both entries
  and the provisioned directory.

  > **Heads-up:** the hook is copied to `~/.flair/hooks/capture/<version>-<hash>/`
  > at install time. Re-run the installation after upgrading `@tpsdev-ai/flair`
  > so the copy matches the running version.
