- **Keyless `flair reembed --agent <id>` no longer counts or re-embeds other agents' listed rows.**
  The keyless listing reads through `POST /SemanticSearch`, whose scope includes other agents' non-private rows. Those rows are dropped before the candidate and up-to-date counts are printed; when any were listed, the summary reports how many were skipped.
