- **The LongMemEval bench now measures and publishes its reader's
  nondeterminism, and states what each hash actually proves.** "Re-run and
  compare within variance" was an empty instruction: we published no variance to
  compare against, so a re-runner whose completion text diverged from ours had
  no way to tell normal from broken. Every run now probes the reader — N
  byte-identical calls on a FIXED, recorded question sample — and records
  distinct completions, common-prefix length and verdict-agreement rate in the
  artifact's **unhashed provenance** partition. The probe issues the main run's
  own reader request builder and takes no reader parameters of its own, so it
  cannot drift into measuring a different configuration; the question sample is
  a hardcoded constant so probes stay comparable across runs; and a probe id
  missing from the dataset is fatal rather than a silent skip. Alongside it, the
  reproducibility language is restated in three tiers: `configHash` is the
  re-derivable anchor and leads, `runHash` is the decision set (re-derivable
  locally, statistical under the cloud profile), and **`artifactHash` is a seal,
  not a proof** — tamper-evidence for a signed-off artifact, never
  reproducibility evidence. "Verify it yourself" rests on `configHash` plus the
  exact prompts, dataset selection and judge rubric. Bench tooling only; nothing
  in the shipped package changes.
