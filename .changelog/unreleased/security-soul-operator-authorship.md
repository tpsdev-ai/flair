- Soul mutations now require operator credentials or deliberate internal calls; agent keys and MCP/OAuth runtimes are denied, including admin agents. Operator edits and provisioning reject text matching stored memories or candidates and stamp their authenticated source. Use `flair soul set --admin-pass-file` for operator edits.

  **Client-library break:** `@tpsdev-ai/flair-client` `soul.set()` still signs with Ed25519 and now receives 403. Write Soul through the CLI (`--admin-pass` / `--admin-pass-file`) or operator REST (Harper administrator Basic).
