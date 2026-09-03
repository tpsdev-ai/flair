- **`--agent <id>` now signs as that agent before `FLAIR_ADMIN_PASS`.** A
  flag-pinned agent authenticates with its own Ed25519 key instead of falling
  back to the environment admin credential. A flag-pinned agent with no key on
  disk is now a hard error naming the agent and the expected key path — the CLI
  no longer silently signs as the admin. Env-pinned agents (`FLAIR_AGENT_ID`)
  are unchanged and still use `FLAIR_ADMIN_PASS` when it is set.
