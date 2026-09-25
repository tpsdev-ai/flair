- **Release auto-tagging decides and writes in separate jobs, and refuses three edges it used to guess at.**

  Four items from review of the automatic release tagger.

  **The decision and the tag write are separate jobs.** Condition 6 executes the
  release commit's own version-sync script. In one job that script shared a
  workspace with the step that mints the GitHub App token, so a merged commit
  could plant a git hook or re-point `.git` and have a later git command run it
  with the token in reach — restoring the working tree never covered that.
  `decide` (conditions 1-9) is now the only place candidate code runs and holds
  no App credential at all; `write` is a separate job on a fresh runner with a
  fresh default-branch checkout, and it alone mints the token, re-checks
  condition 10 and creates the tag. Every checkout sets
  `persist-credentials: false`, and the refusal reporter reads the write job's
  outputs before the decide job's.

  **The trigger's path guard tolerates the `@<ref>` suffix** that GitHub reports
  in `workflow_run.path`, so the exact comparison no longer fails on every normal
  CI completion.

  **An empty check list is not "all checks green".** Condition 9 now requires a
  check run from the CI workflow's check suite present on the commit — the suite
  that woke the tagger, or a completed CI suite on that commit for the nightly —
  and otherwise refuses with `checks-missing` instead of tagging a commit the CI
  workflow never ran on.

  **The nightly finds the release commit, or refuses.** It walks the version
  file's own git history instead of a fixed 200-commit window, so a version
  change any distance back is found; when the walk cannot find it, the run
  refuses with `version-origin-not-found` rather than skipping silently.
