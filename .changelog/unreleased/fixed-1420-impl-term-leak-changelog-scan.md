- **The impl-term-leak gate now scans `CHANGELOG.md` and `.changelog/`.**
  Release notes and unreleased fragments are consumer-facing; a bead-shaped
  token in a fragment used to survive until the release cut. The empty-scan
  refusal is unchanged. Allowlisted English compounds (`ops-port`, `ops-api`,
  `ops-target`, `ops-server`) still pass.
