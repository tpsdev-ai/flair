- **A stale hook pinned with both a pre-release and a build suffix is re-pinned, not held.**

  The installer-form matcher admitted a pre-release OR a build suffix but not
  both at once, so a pin such as `0.54.0-rc.1+build.5` matched no form: a stale
  `flair-session-start` hook was HELD and left running the previous adapter
  instead of being updated. The three forms now carry separate optional
  pre-release and build groups, so a combined suffix is matched and re-pinned;
  only the pinned package span changes.

  (Refs #1834)
