- **Team directory: an operator publishes an agent's tps-mail address, and any verified active agent finds it.**
  `Integration.directoryPublishedAt` records an operator-approved contact. Publication, withdrawal and
  removal of a published entry are operator-only; the address is frozen until an explicit withdrawal, and
  the publication stamp is server-set. One resolver serves the `team_directory` MCP tool, `GET /TeamDirectory`
  and the flair client with identical results. Bootstrap carries a fixed directory hint (flair#2141).
