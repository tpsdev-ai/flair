- **`flair status` no longer reports "all checks passing" while the ops API is
  exposed on all interfaces.** It now surfaces the same finding `flair doctor`
  already made, so the two commands cannot disagree about the same instance.

  > **Heads-up:** a local install whose Harper ops API is bound to every
  > interface now shows a warning in `status` (and in `status --json`) instead
  > of a green verdict. The fix is unchanged: `flair init && flair restart`
  > rebinds it to loopback, or pass `--ops-bind` to keep it deliberately
  > reachable.
