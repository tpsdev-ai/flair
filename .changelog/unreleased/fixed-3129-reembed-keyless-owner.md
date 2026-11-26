- **Keyless `flair reembed --agent <id>` no longer counts or re-embeds other agents' listed rows.**
  The keyless listing reads through `POST /SemanticSearch`, whose scope includes other agents' non-private rows. Those rows are excluded from the candidate, up-to-date and updated counts and reported as skipped in `Skipped (other agents)`.
