- **Test pause points need no central list, so a PR that adds one does not conflict.** `txnPausePoint` takes a name checked against a
  lowercase-words-and-hyphens pattern at call time and refuses a non-matching name with `InvalidPausePointError`; a unit test scans the
  source for the names in use and fails on a malformed or duplicate one. The fault-injection gate is unchanged.
