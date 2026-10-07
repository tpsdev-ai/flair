- **Feed-written ephemeral memories now carry the tier expiry, so routine maintenance reaps them.**
  The feed ingest writes through the raw Memory table and never stamped `expiresAt`, so an
  ephemeral row written there outlived the documented 24-hour tier. It now stamps the same
  expiry through one shared `durability -> expiresAt` rule, also applied by the Memory
  patch route, the agent seed and the federation merge (flair#2274).
