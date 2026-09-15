- **`flair doctor --fix` no longer writes a launchd job that cannot start because its admin-password file is missing.**

  Adoption now creates `~/.flair/admin-pass` (0600) from a credential proven
  against the running instance, or refuses with the exact command to fix it;
  repair of a stopped instance follows the same rule. Adoption also proves the
  launchd job — not the old process still answering the port — serves the
  instance before reporting success, and a plist that still carries the password
  inline is reported as a failure (Refs #1685 #1693 #1684 #1573).
