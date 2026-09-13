- **The build now refuses to ship CLI code that Node cannot load.** A command
  module that combined CommonJS `require()` with top-level `await` made Node
  reject the file at runtime — the crash behind `flair session snapshot list` —
  and the new check fails the build before that reaches a release (flair#1653,
  flair#1657).
