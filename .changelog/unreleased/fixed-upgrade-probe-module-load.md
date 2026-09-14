- **`flair upgrade` now reliably detects installed libraries and the OpenClaw plugin.** The version checks failed in the compiled CLI and could report an installed package as missing; they now load their helpers the same way as the rest of the command (flair#1657, flair#1658).

  The checks only misbehaved in the built CLI under Node — the test suite's
  runtime tolerated the old pattern, so it could not catch it. A new test now
  runs the shipped CLI through Node, and the build refuses to emit the pattern
  that caused it.
