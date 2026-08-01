- Restated the downgrade invariant (flair#1050): there is never a silent bad
  outcome — either the old binary boots and serves the corpus correctly, OR it
  refuses to start with a message naming what wrote the store, what is running,
  and how to recover, with a pre-upgrade snapshot that restores the store to a
  working state. The migration CI lane and downgrade-boot compat test now assert
  both branches, and the snapshot-opt-in rationale in docs and CLI docstrings
  reflects the restated guarantee.
