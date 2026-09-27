- **ADK and Hermes descriptions now clarify the audited behaviors.**
  The ADK app/user tag is described as a retrieval filter within one Flair principal; re-ingestion reuses record IDs when the app, user, session, and nonempty event IDs are unchanged; missing event IDs receive fresh UUIDs; the key-file formats each loader accepts are listed; listing and search are described with the filters each sends. Hermes describes its returned-row ordering and that it attempts to mirror add operations only.

  (Refs #1943)
