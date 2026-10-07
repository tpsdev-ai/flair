- **Hook install and uninstall leave the matcher of a shared hook group unchanged, moving Flair's entry into its own group.**

  A group whose hooks are all Flair's still has its matcher repaired. A group
  that also holds the user's hooks keeps its matcher and those hooks; Flair's
  entry moves to a dedicated group. Uninstall removes Flair's own entries and
  leaves the rest alone (#2264).
