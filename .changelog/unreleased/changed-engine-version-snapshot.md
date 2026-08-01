- **Pre-upgrade snapshots are now automatic when the Harper engine version changes.** The tested-downgrade guarantee that justified making snapshots opt-in does not hold across engine version boundaries — a Harper bump is the only realistic source of a cross-version boot break. Opting out requires `--no-engine-snapshot` and prints what is being given up.

  Ordinary flair-version upgrades (same Harper) remain opt-in via `--snapshot`.
