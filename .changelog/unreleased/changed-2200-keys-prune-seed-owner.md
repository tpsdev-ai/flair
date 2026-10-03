- **`flair keys prune --apply` moves an instance seed only when its owner record proves the targeted instance owns it.**
  A minted instance seed now records its instance id and data directory in a
  keystore-managed sidecar beside the seed. `--apply` moves a node-shaped seed only
  when the sidecar names the targeted instance's data directory (`--data-dir <dir>`)
  and the targeted instance's `Instance` table does not reference the seed. A seed
  with no owner record, an unreadable or malformed one, or one naming another
  instance is listed with the reason and left in place.
  `flair doctor`'s advisory is unchanged.
