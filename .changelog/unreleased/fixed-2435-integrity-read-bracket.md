- **The integrity scan's bounded deletion-history read is count-bracketed, and `flair integrity prune-history` no longer reads any Memory rows (flair#2435).**

  `flair integrity check` reads deletion history in a watermark-bounded window; a
  result shorter than that window's own row count is now reported as a read error
  (UNKNOWN, exit 3) instead of an unexplained-loss alert. The window's count is a
  SQL count of the same range, because `describe_table` counts a whole table, not
  a range.

  `flair integrity prune-history` reads the named checkpoints and the history it
  may prune, and no longer reads Memory. Its cutoff, cap, dry run and refusals are
  unchanged.
