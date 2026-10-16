- **The integrity scan collapses a duplicate id only when every requested field has
  the same presence and parsed value.** Differing projections or count mismatches
  trigger up to three reads; any other read failure reports UNKNOWN at once. Exhaustion reports
  UNKNOWN without advancing the checkpoint. Matching counts and projections do
  not establish a transactional snapshot under balanced concurrent writes.
