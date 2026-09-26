- **`flair-bootstrap`, `flair-sync`, `flair-sync-soul`, `migrate-memories`, and `flair-activity` refuse to run without an explicit agent identity.**

  Each resolves `--agent <id>` or `FLAIR_AGENT_ID` and exits non-zero, naming
  both remedies, before reading a key file or making a request — no shipped
  default identity can sign as a principal the caller did not choose. The
  watchdog's mail alert takes its sender from `FLAIR_AGENT_ID` /
  `HARPER_WATCHDOG_AGENT_ID` and skips, logging the same remedy, when neither is
  set; `repro-resource-busy` and `flair-client` already refused and continue to,
  reads included. A CI guard fails any new default under `scripts/`.

  (Refs #1822)
