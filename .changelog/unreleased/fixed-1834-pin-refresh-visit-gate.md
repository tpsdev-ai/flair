- **A pin refresh no longer reports a missing client directory as a failure, and duplicate-key detection compares decoded key names.**

  `flair upgrade`'s refresh now visits an MCP client only when its config
  directory exists — an absent parent (a Claude-Code-only machine has no
  `~/.gemini`, `~/.cursor` or `~/.gemini/config`) is a quiet "not wired" skip
  instead of 2-3 failure-looking lines. A genuinely unreadable parent
  (EACCES / ELOOP / ENOTDIR) is still reported loudly. The duplicate-key guard
  now compares DECODED key names, so a Unicode-escaped duplicate can no longer
  slip past it and drop the shadowed entry's bytes; a HOLD leaves the file
  byte-identical. The install-health catalog flags a behind MCP pin on an entry
  without an identity (the same entry `doctor --fix` repairs), and `doctor`
  prints a held pin with a warning icon.

  (Refs #1834)
