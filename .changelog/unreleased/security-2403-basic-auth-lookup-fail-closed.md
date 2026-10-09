- **A Basic-auth Agent lookup that fails refuses the request instead of admitting it.**
  A credentialed Basic request whose Agent row cannot be read — a read error, not an
  absent row — is refused with the named `agent_lookup_failed` error. A read that
  succeeds decides as before (flair#2403).
