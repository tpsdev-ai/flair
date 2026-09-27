- **The Pi extension's documentation and tool text describe what it does.**
  The README and source header say the required identity comes from the environment that launches Pi and list the variables the extension reads, the tool signatures match the tools' schemas, and the `memory_store` tool says ephemeral memories expire after the server-configured TTL (24 hours by default). An unused function that guessed an agent id from the working directory is removed.

  (Refs #1943)
