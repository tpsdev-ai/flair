- **The n8n nodes support Ed25519 signing with Agent Private Key; the admin password is deprecated (flair#1942).**

  With Agent Private Key selected, requests sign as the credential's Agent ID.
  Ordinary agents read their own and other agents' non-private memories.
  The deprecated Admin Password path uses Harper administrator Basic
  authentication only with an empty Agent Private Key, and warns on each node execution.

  > **Heads-up:** base64-encode the raw key file from `flair agent add <agent-id>`
  > (`base64 < ~/.flair/keys/<agent-id>.key`) for Agent Private Key.
