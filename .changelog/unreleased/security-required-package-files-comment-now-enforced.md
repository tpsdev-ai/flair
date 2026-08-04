- **`REQUIRED_PACKAGE_FILES`'s "keep in sync" comment is no longer a promise nobody kept.** It
  claimed to mirror `files`; nothing compared them, and they drifted invisibly for as long as the
  comment existed. The payload is now derived from `files` directly, so there is one source of truth
  and nothing to synchronise by hand. Four tests assert the deployed set — including that the filter
  is not over-broad, since a filter that drops everything would also pass a "no `.git` shipped" check.
