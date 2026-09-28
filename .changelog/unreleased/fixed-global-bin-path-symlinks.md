- **Symlinked PATH directories no longer trigger false missing-PATH warnings.**
  Flair recognizes version-manager aliases that resolve to its global bin directory,
  so it does not suggest adding a Node version's real directory when an alias
  already covers it. Broken or unreadable PATH entries do not interrupt the check.
  Refs #2034 (part 1 of 2).
