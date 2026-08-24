- **Hosted-Flair auth guide for adapters.** If your agent just got a 404
  against a hosted instance, identity is three things that must match
  (Ed25519 keyfile + agent id + the `Agent` row on **that** instance),
  the failure is one of three shapes (record missing / key mismatch /
  config wrong), and a 404 on by-id routes is fail-closed ownership —
  never an existence signal. Lives in `docs/integrations.md` (the shared
  adapter home) and the adk-flair README hosted section; pointers from
  auth, Fabric, troubleshooting, and mcp-clients. Docs slice of
  flair#1338 only — not the canary / hosted-shape CI program.
