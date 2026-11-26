- **On POSIX, `flair doctor` and a local `flair status` warn when an agent key
  file is wider than owner-only.** Both name the path, its mode and
  `chmod 600 <path>`, and neither changes the file. A symlinked agent key is
  reported as not checked.
