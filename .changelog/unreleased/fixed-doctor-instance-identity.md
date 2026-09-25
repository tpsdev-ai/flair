- **`flair doctor` reports two instance-identity mismatches, each with the one command that fixes it.**

  A second `Instance` row (no canonical identity, so the cleanup sweep cannot
  know whether the instance is a hub) and the `flair_pair_initiator` role on an
  instance whose identity row is not a hub.

  Both are read from the instance itself. If that read does not happen the check
  reports UNVERIFIED rather than passing, and a consistent instance reports
  nothing.
