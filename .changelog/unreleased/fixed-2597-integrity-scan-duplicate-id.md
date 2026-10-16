- **The integrity scan collapses byte-identical projected duplicates.** Differing
  projections or count mismatches trigger up to three reads. Exhaustion reports
  UNKNOWN without advancing the checkpoint. Matching counts and projections do
  not establish a transactional snapshot under balanced concurrent writes.
