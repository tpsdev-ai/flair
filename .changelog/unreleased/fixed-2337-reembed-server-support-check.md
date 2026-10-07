- **`flair reembed` refuses before its first write when the server does not advertise the re-embed PATCH.**

  The command reads the server's advertised capabilities from `GET /Health`
  before the first write. A server built before that PATCH existed does not
  advertise it, so the command stops with what it found and the remedy —
  restart or upgrade the server, then re-run `flair reembed` — rather than
  sending a PATCH whose support it could not confirm. A read that cannot
  confirm support is refused the same way, never treated as support.
