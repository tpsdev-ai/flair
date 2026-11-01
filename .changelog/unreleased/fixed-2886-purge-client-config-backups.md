- **`flair uninstall --purge` removes the client-config `.bak` copies that still carried Flair's wiring.**
  Unwiring each client snapshots its config to a sibling `<config>.bak`, and purge now deletes that
  snapshot when it contains a Flair entry — tested with the same detection that client's unwire uses —
  listing the path under `Removed`. A snapshot with no Flair entry may be the user's own copy and stays.
  A snapshot that cannot be read or parsed is listed under `Not checked` and left in place, and the
  run exits non-zero. Plain `flair uninstall` keeps every backup.
