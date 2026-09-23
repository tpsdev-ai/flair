- **`flair init --data-dir <long>` now refuses with a clear message instead of Harper's bare `listen EINVAL`.**

  A Unix domain socket's path is capped by `sun_path` — 104 bytes on macOS and
  108 on Linux, both counting the trailing NUL — so the usable length is 103 /
  107 bytes. The operations API socket lives at `<data-dir>/operations-server`,
  and a data directory long enough to push that socket past the cap made Harper
  die on `listen` with a code-level error that named neither the socket nor the
  limit — at first run, with no working install to compare against.

  init now measures the computed socket path in bytes and refuses **before**
  touching disk, naming the path, its byte length, the platform limit, and how
  many bytes shorter the `--data-dir` must be. `flair start` and `flair restart`
  run the same (defensive) preflight, in case a future flag or a lengthened
  default ever makes the limit reachable there.

  (Closes #916)
