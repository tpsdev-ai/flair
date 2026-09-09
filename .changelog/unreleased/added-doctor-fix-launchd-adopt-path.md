- **`flair doctor --fix` now adopts a detached (direct-spawned) instance into
  launchd.** When the instance is running outside launchd, the repair
  clean-stops the live process (SIGTERM, wait for exit), confirms the port is
  free, regenerates the plist, loads it, and verifies launchd is managing it —
  refusing to signal a process it cannot attribute to this instance.
