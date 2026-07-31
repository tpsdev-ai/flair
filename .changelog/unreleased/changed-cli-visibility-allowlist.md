- **`flair memory add --visibility` accepts only `private` or `shared`.** It
  previously forwarded whatever it was given. Because the read scope tests
  visibility by exact match against `private`, every other value — `prvate`,
  `Private`, `office` — was treated as non-private and returned to every agent
  on the instance. A typo in the flag whose entire purpose is to keep a memory
  owner-only produced a memory that was not, silently and with a zero exit code.
  Unrecognised values now exit non-zero, naming the two valid ones, before any
  write leaves the CLI.

  This retires `--visibility office`, which was a real read-scope tier when the
  flag shipped and was removed as a read leak. Nothing in the read path has
  branched on it since, so an office-stamped memory is indistinguishable from a
  shared one — `--visibility shared` is the value that means what it used to
  mean. Scripts passing it get an error naming the replacement rather than a
  tier the server stopped implementing.
