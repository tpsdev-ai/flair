- **The SessionStart hook now fails quietly, and `flair doctor` notices when it stops working.** The
  hook Flair registers resolves a package binary through your Node runtime, and under a Node version
  manager globally installed packages are per-runtime-version — so a routine, unrelated runtime
  upgrade could orphan it. The hook then failed on *every* session, indefinitely, with a message that
  named neither Flair nor a remedy, and it kept doing so after Flair itself was gone (#1007). The
  registered command is now wrapped so any failure to resolve or execute produces no output and exits
  0, on every shell tested (sh, bash, zsh, dash, ksh, fish, tcsh — the previous form was broken
  outright in the last two). The adapter's own no-op-on-failure guarantee could not cover this: it
  lives inside the binary that never ran. `flair doctor` now *runs* the registered command — bounded,
  and side-effect-free via a new `FLAIR_HOOK_PROBE` mode that makes the hook answer and exit without
  touching the network — so a hook that no longer resolves is reported with a remedy instead of
  staying invisible. `flair doctor --fix` rewrites an older, loud hook in place, keeping its agent and
  instance; it never rewrites a hand-edited one and never removes a hook. `flair hook status` gained an
  **On failure** line. Agent ids and URLs are now refused rather than escaped if they contain
  characters that are not safe in a shell command.
