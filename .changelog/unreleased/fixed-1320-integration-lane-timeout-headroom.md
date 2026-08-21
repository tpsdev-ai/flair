- **CI: the Integration Tests lane no longer runs at its 30-minute ceiling.**
  The lane had grown to 29m58s on a good run — sibling runs were being
  timeout-cancelled at 30m10s and misread as runner flake (flair#1320). The 14
  heaviest real-Harper-boot suites (746s of measured CI time, led by
  `recall-eval-gate` at 244s) moved to `test/integration-heavy/`, the dedicated
  heavy job from flair#1290/#1299, putting both lanes at ~17m30s projected.
  The heavy job's timeout is resized 20 → 30 minutes to fit its
  deliberately-added content with honest headroom. No test content changed —
  moves only; nothing about what CI covers per push/PR changed.
