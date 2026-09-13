- **Self-heal requires Flair's /Health identity and the launched pid on the port.** A foreign 200 or a stale listener is not healed (flair#1478).

  `flair stop` / `start` no longer treat “an HTTP server answered on this port” as proof the pre-#1454 daemon is ours. Adoption of a reconstructed `flair-daemon.json` now requires a 2xx `/Health` body that matches Flair’s public shape (`ok`, `version`, `searchReady`, `buildCommit`) and, when `lsof` can see the listener, that the port-owning pid is the instance we launched (worktree + `ROOTPATH` / dataDir). A decoy 200-responder or a leftover pid after a failed restart reports not healed.

  > **Heads-up:** a process that answers 200 on Flair’s port is not enough. If `/Health` is not Flair, or a different pid still holds the port, the CLI refuses rather than claiming the daemon was healed.
