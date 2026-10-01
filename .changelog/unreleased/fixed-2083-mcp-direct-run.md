- **`flair-session-start` and `flair-continuity-capture` start from a path that contains a space, or from a symlinked bin, on Node before 22.18.**
  Those hooks, and a direct run of the MCP server module, decided they were
  the process entry by comparing the module URL to `argv[1]` as strings when
  `import.meta.main` was absent. A space is `%20` in the URL, and an npm bin
  is a symlink, so the process exited without running. They now compare the
  two paths after resolving symlinks. The same check is what
  `flair-prompt-recall` and `flair-precompact` already used.

  (Closes #2083)
