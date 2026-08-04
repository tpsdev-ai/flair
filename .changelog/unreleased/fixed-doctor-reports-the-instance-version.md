- **`flair doctor` no longer reports the local CLI's version as the instance's.** Pointed at a
  deployed instance, every line doctor printed was genuinely remote — uptime, PID, memory counts —
  except the one that mattered: it ran the currency check against `__pkgVersion`, the CLI you happen
  to have installed, and printed `flair <x> is current`. Reported against an instance five minors
  behind, where doctor said "current". Telling you that is doctor's entire job.

  It now probes the target's `/Health` and reports the version running **there**, and warns
  separately when the local CLI and the instance differ.

  **An undeterminable version is reported as unknown and counts as an issue — it never falls back to
  the local number.** An older instance may not expose its version at all, and substituting the one
  already in hand is exactly the bug being fixed. A Fabric node mid-failed-deploy reports a
  non-semver marker (`dev`); that is a real answer from a real server and still cannot be compared
  against a published version, so it is treated as undeterminable rather than fed to a semver check.
