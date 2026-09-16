- **A current server now refuses an identified pre-0.18.0 flair-client on memory writes, and `flair doctor` names the silent-drop pin.**

  `@tpsdev-ai/flair-client` before 0.18.0 still suppresses writes on the
  client — `written: false`, a `mergedWith` id, zero rows — including when
  the match is another agent's `shared` memory. The PUT never arrives, so
  no server upgrade closed it. Current `flair-client` now sends
  `X-Flair-Client: flair-client/<version>`; a write that declares `< 0.18.0`
  is HTTP 426 `stale_flair_client`. `flair doctor` fails a
  `flair-mcp@<0.18.0` pin with that hazard and `flair upgrade` as the
  remedy. Missing version is still served — published 0.18–current clients
  did not send a library version.

  > **Heads-up:** if writes look stored but never land, upgrade the adapter
  > (`flair upgrade` / pin `@tpsdev-ai/flair-mcp` and `@tpsdev-ai/flair-client`
  > >= 0.18.0), not the server. Restart the MCP host after the pin moves.
