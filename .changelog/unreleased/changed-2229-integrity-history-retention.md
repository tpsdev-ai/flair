- **The integrity scan bounds its deletion-history read by the checkpoint watermark, and `flair integrity prune-history` reclaims older history rows (flair#2229).**

  `flair integrity check` reads deletion history at or after the checkpoint's
  watermark minus a margin (five minutes — wide enough to cover the delay
  between a delete stamping a history row's `at` and that row becoming readable
  to the scan). A checkpoint with no readable watermark reads the whole table.
  A new checkpoint records the watermark, never advancing it past a history row
  the checkpoint still needs.

  `flair integrity prune-history` is a separate, opt-in, one-shot command. With
  `--apply` it deletes history rows older than the OLDEST named checkpoint
  watermark minus the same margin, at most `--max` (default 500) rows per run;
  without `--apply` it reports what it would prune and deletes nothing. It
  prunes nothing — and says why — when a checkpoint is missing or a watermark is
  unreadable. The deletion-history table declares `replicate: true` explicitly,
  stating the database default.
