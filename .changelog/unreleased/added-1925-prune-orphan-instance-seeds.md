- **`flair keys prune` and `flair doctor` report node-shaped orphan candidates without removing them.**
  Candidates are absent from the checked target's Instance and Agent tables;
  unreadable rows leave files unidentified. The read requires a local HTTP target,
  its derived ops port and an admin credential. Node-shaped seeds stay in place
  even with `--apply`; removal requires per-file ownership proof (#2200).
  Doctor's advisory names no removal command (flair#1925).
