- **`flair reembed` refuses before its first write when the server does not advertise the re-embed PATCH.**

  The command reads the server's advertised capabilities from `GET /Health`
  before the first write. If the token is absent, the command stops with
  what it found and the remedy —
  restart or upgrade the server, then re-run `flair reembed`.
  A failed or unparseable `/Health` read is also refused.
