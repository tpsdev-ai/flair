- **`flair doctor` no longer mistakes node-scoped federation keys for agent
  signing keys.** `~/.flair/keys/` holds two kinds of file — agent Ed25519
  signing keys (a `<name>.key` seed with a sibling `<name>.pub`) and
  node-scoped federation keys (`flair_<hex8>.key`, an AES-GCM keystore blob
  with no `.pub`). Doctor used to Ed25519-parse the node blob and warn that an
  agent's signing key "could not be parsed … (DECODER routines::unsupported)",
  which reads as agent-auth breakage when agent auth is fine. Node keys are now
  classified structurally and skipped, with an informative note instead of the
  false alarm.

  This also closes a way `flair doctor --fix` could wire a broken connector: on
  a host whose only key was a federation node key, `--fix` could infer that node
  id as the sole agent and write `FLAIR_AGENT_ID=flair_<hex8>` into a client
  config, so the connector authenticated as a phantom, unregistered node whose
  key cannot sign — failing every read and write. `--fix` now refuses to wire a
  node id from any source and points at `flair init --agent <name>` or
  `flair agent add <name>` instead.
