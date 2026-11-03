- **Replace restore and REM restore stop before deleting anything when a Soul row they would replay supplies a non-empty `scopeTag` or `tags` array.**

  The server refuses that write, so a refused replay no longer removes the live
  Soul row first. Replace mode checks the archived rows it replays; REM checks
  the snapshot rows and the live rows captured in its pre-restore snapshot.
  A refused row is named with its id and the run exits non-zero without
  deleting or writing target rows. A replay whose checked rows pass the check
  is unchanged. Merge restore deletes nothing and is not affected (#2931).
