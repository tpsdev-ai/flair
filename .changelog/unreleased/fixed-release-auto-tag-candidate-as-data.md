- **The release tagger reads the candidate commit as data, and the write job re-derives the decision (flair#1890 round 3).**

  Two hardening items on the automatic release tagger.

  **No candidate code runs at all.** Condition 6 used to execute the release commit's own version-sync script, so that script could write the step's verdict output (`verdict=TAG`) or a substituted sha and the write job would act on it. The candidate's version-bearing files are now materialised from git objects (`git show <sha>:<path>`) into a scratch directory and checked by the DEFAULT branch's checker; a candidate's own script is never executed, in any job.

  **The write job trusts nothing from `decide`.** It binds the target commit independently (the triggering run's own head sha, or its own nightly recomputation) and re-runs conditions 1-9 for that commit before it mints the App token. `decide`'s outputs only gate whether `write` starts and feed the refusal report — they never choose what gets tagged.
