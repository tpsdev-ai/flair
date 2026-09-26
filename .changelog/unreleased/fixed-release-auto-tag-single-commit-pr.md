- **A release PR must be a single commit, and the tagger refuses one that is not (flair#1890 round 7).**

  Condition 7b compares the tagged commit's diff against its first parent, which
  is the whole release PR only under a squash merge; the repository also allows
  rebase merges, where an earlier commit of the same PR lands before the tip and
  7b never sees its files. The tagger now reads the release PR's commit count
  from the pulls API and refuses `release-pr-not-single-commit` unless it is
  exactly 1 — in the decision and again at the tag write, so a multi-commit
  release can never be tagged on the strength of the tip's diff alone.
