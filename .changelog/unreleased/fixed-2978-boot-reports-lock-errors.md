- **Migration boot reports lock refusals classified as errors.**
  Mutex release failures during acquisition are errors, including after finding a holder.
  A later acquisition by the same process can reclaim its abandoned record and mutex generation after a post-publication release failure. ([#2981](https://github.com/tpsdev-ai/flair/pull/2981))
