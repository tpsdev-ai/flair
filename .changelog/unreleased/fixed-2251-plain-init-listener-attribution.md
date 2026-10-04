- **Plain `flair init` attributes a listener before it sends any admin
  credential.** It reuses the pid/owner proof `--skip-start` already applies:
  a listener on the configured HTTP or operations port is accepted only when it
  is this data directory's own instance, and is otherwise refused by name and
  receives no credential.
