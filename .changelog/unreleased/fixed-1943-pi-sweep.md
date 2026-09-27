- **Clarify Pi identity setup, registered tool signatures, and ephemeral expiry text.**
  The README and source header say the required identity comes from the environment that launches Pi and list the FLAIR_* variables getConfig reads. The header's tool signatures and the README's tool table match the registered schemas. The memory_store tool describes the server-stamped expiresAt (24 hours by default) and that search and bootstrap skip expired rows. An unused helper that guessed an agent id from the working directory is removed.

  (Refs #1943)
