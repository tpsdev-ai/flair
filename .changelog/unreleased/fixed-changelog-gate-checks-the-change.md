- **The changelog gate now asks whether *your* change wrote an entry, not whether the directory is
  non-empty.** The old rule fired only when `.changelog/unreleased/` was empty *and* feat/fix commits
  had landed since the last tag — so the first PR after a release cut satisfied it for every PR that
  followed, until the next cut emptied the directory again.

  That is not hypothetical. On 2026-08-03 four PRs merged with no fragment while the directory held
  three entries from earlier work; the gate passed on all four, and v0.36.0 was assembled with
  release notes omitting three authz security fixes — the entire reason to upgrade. They were
  backfilled by hand at the cut, which is the moment this check exists to make unnecessary.

  The gate now also compares against the PR's merge base and requires a fragment to have been
  **added** in that range. Editing an entry someone else staged is not writing your own. The
  since-tag rule is kept, because it still catches the empty-directory-at-release case; where no
  base ref is reachable (shallow clone, no `origin`) the per-change half is skipped and the
  since-tag half still runs.
