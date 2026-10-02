- **The n8n nodes sign every request as the credential's agent (Ed25519), not with the instance admin password (flair#1942).**

  The FlairApi credential now holds an agent id and that agent's Ed25519 key, and
  each node signs as that agent through flair-client, so a workflow reads that
  agent's memories and other agents' non-private memories — never another agent's
  private ones (a signed request is scoped server-side). The v1 admin password
  remains as a deprecated field, used only while the key is empty; it
  authenticates as the Harper administrator, which can read and write the whole
  instance including other agents' private memories, and every execution that
  uses it logs a warning.

  > **Heads-up:** a credential that still uses the admin password keeps working
  > and starts warning on every execution. Mint an agent key with
  > `flair agent add <agent-id>`, encode the key file
  > (`base64 < ~/.flair/keys/<agent-id>.key`), and fill in Agent Private Key to
  > move the workflow onto that agent's identity.
