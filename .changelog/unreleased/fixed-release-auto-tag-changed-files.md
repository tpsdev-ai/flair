- **The release shape check reads the release commit's own diff, and allows only
  the lockfile this repo tracks.** Condition 7b listed a release PR's changed
  files through the pull-request files API, which caps at 3,000 files and answers
  a first-page 404 with an empty list — so a truncated list, or a 404, passed the
  subset check vacuously. The list now comes from
  `git diff --name-status -M <sha>^1 <sha>` on the release commit itself:
  complete, no API, and a rename is reported with both of its paths, so a release
  cannot move a file out of the trust root and still pass. An empty diff is
  refused — a release changes at least its version-bearing files. And the
  lockfile allowance is no longer the list of lockfile names in general but the
  lockfile(s) this repo tracks at its own root (`bun.lock`), so a release cannot
  swap in one the repo does not use.
