# Fixture changelog for flair#1392 Heads-up rendering

## [0.49.0] - 2026-08-24

### Fixed

- **Identity mapping now enforces one active IdP credential per subject** (flair#1317).
  Provisioning used to insert a second active credential. The body of this
  entry must not appear in the rendered notes — only the lede, the issue
  link, and the Heads-up.

  > **Heads-up:** before this fix, `revoked` was not terminal.

- **A second entry with no operator line** (flair#1363, #1357, #9999, #10000).
  Extra issue refs past the first three must be dropped. This body stays out
  of the notes.
