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

- **`models/*.gguf.downloading` is now ignored.** `.gitignore` covered `*.gguf` but not the
  in-progress placeholder Harper writes beside it, and the integration harness points
  `FLAIR_MODELS_DIR` at the repo's own `models/` directory — so a killed test run left an untracked
  file in the working tree.

- **Removed the redundant `postinstall` chmod.** npm already sets the executable bit on files
  referenced by `bin` when it links them; the script changed nothing and cost a line in npm's
  install-script approval prompt, on a package whose install output is already noisy.

- **`docs/upgrade.md` no longer links to a CHANGELOG that isn't there.** The guide ships in the npm
  package and pointed at `../CHANGELOG.md`, which the `files` allowlist excludes — so the first
  instruction in the upgrade guide was a dead link for every reader who installed from the registry.
  The three links now resolve to the published copy on GitHub, rather than adding a 1400-line file
  to an install that is already too heavy.
