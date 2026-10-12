- **The integrity scan bounds and count-brackets deletion-history reads, and `flair integrity prune-history` can reclaim older history rows with `--apply` (flair#2229, flair#2435).**

  `flair integrity check` reads deletion history at or after the checkpoint's
  watermark minus a five-minute margin. A checkpoint with no readable watermark
  reads the whole table. A new checkpoint records the watermark, never advancing
  it past a history row the checkpoint still needs.

  The bounded read is bracketed by SQL counts of the same range. A result that
  differs from the range's count, or a count that changes during the read,
  reports UNKNOWN (exit 3).

  `flair integrity prune-history` is a separate, opt-in, one-shot command. With
  `--apply` it deletes history rows older than the OLDEST named checkpoint
  watermark minus the same margin, at most `--max` (default 500) rows per run;
  without `--apply` it reports what it would prune and deletes nothing. The
  command reads no Memory rows. It prunes nothing — and says why — when a
  checkpoint is missing or a watermark is unreadable. The deletion-history table
  declares `replicate: true` explicitly,
  stating the database default.
