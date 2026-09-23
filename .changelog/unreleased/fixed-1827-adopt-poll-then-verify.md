- **The macOS launchd adopt repair now waits for the started process before judging it, instead of failing on one early observation.**

  `flair doctor --fix`'s launchd adopt arm read the serving pid and the
  post-stop port health exactly once — before the launchd-started Harper had
  written `hdb.pid` or bound the port — so a healthy slow start was reported as a
  false failure ("port not confirmed free after stopping the direct process").
  Both sides now poll until the evidence is decisive or a deadline (the startup
  budget) passes, then apply the existing verdicts unchanged. If the deadline
  passes, the failure names how long it waited and what it last observed; the
  remedies are unchanged. Adoption is still proven by identity and change, never
  by port health alone.

  > **Heads-up:** on macOS, `flair doctor --fix` can now take up to the startup
  > budget when adopting an instance into launchd — it waits for the process to
  > serve rather than failing fast on a slow start.

  (Closes #1827)
