- **On POSIX, `flair doctor` and a local `flair status` warn when an agent key
  file is wider than owner-only.** The ID must pass the Agent ID
  rule; no `.pub` sibling is required. Both name the path, its mode and
  `chmod 600 <path>`. A symlinked agent key is
  reported as not checked, as are other matching non-regular entries. The check
  reads the directory (following a symlinked keys directory) and lstats matching
  entries; it reads no key contents and changes no files.
