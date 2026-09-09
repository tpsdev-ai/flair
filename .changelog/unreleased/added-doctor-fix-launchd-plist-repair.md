- **`flair doctor --fix` now repairs a missing or corrupt launchd plist.** It
  regenerates the plist in the secret-free pass-file mode, loads it, and
  verifies launchd is managing the instance — refusing to touch a plist that
  belongs to another data directory.

  The regenerated plist's root path and ports come from the instance's own
  `harper-config.yaml`, never defaults or `~/.flair/config.yaml`. A valid plist
  whose root path names a different data directory is left untouched and named
  in the refusal.
