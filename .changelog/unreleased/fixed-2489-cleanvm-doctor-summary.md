- **The clean-VM CI gate lists every `flair doctor` finding when it cannot tell which ones doctor counted (#2489).**

  A counted doctor check can print as a `⚠` warning, so when the `✗` findings
  matched the summary count the gate could show the wrong one. It now lists the
  `✗` findings only when every finding is a `✗` and their number matches the
  summary, and otherwise lists every finding with the lines doctor printed under
  them. The gate still fails on the same condition as before: doctor exiting
  non-zero.
