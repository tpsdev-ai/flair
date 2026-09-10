- **The launchd launcher now re-verifies the admin-pass file is owner-only
  (0600) at read time.** It refuses to read a file that drifted to a group- or
  world-readable mode after `flair init` (umask change, backup tool, tar
  restore), instead of trusting the init-time mode and leaking the secret.

  The launcher also checks the file is readable (`-r`) before reading it, and
  fails closed with a clear error on a non-0600 or unreadable file — mirroring
  `readSecretFileSecure`'s refusal of any group/other permission bit.
