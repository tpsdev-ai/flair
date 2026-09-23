- **A pin refresh whose write is refused now reports a failure, never a false success.**

  The shared in-lock pin-only writer stored its "re-pinned" verdict in memory
  *before* the write committed. If the atomic replace then refused — a staging
  failure, a non-regular destination, a rename failure — `flair upgrade`'s pin
  refresh and `flair doctor --fix` still reported `re-pinned …` with
  `ok: true`, while the config on disk still held the old pin: a failed write
  reported as success. A decided re-pin is now truthful only for a committed
  write; any failure after the decision is reported as a failed write — the
  target is skipped, `ok` is false, and the reason is printed, with the bytes
  untouched. The JSON and Codex-TOML pin writers share this seam, so one fix
  covers both.

  > **Heads-up:** nothing to do. A refresh that cannot complete its write is
  > now loud instead of silently claiming the new pin.

  (Refs #1834)
