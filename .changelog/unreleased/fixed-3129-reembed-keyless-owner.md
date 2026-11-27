- **Keyless `flair reembed --agent <id>` excludes other agents' listed rows from the candidate, up-to-date and updated counts, and reports them in `Skipped (other agents)`.**
  The keyless listing reads through `POST /SemanticSearch`, whose scope includes other agents' non-private rows. A listing at the row limit exits non-zero without a success marker.
