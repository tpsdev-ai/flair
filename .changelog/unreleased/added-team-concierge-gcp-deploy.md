- Team Concierge GCP deploy package (`examples/team-concierge/deploy/gcp/`):
  a 10-minute operator runbook + deploy script putting the example on Vertex
  AI Agent Engine with Gemini and memory on a self-hosted Flair Fabric hub —
  the Ed25519 identity is minted in Cloud Shell, delivered to the runtime via
  a Secret Manager env reference, and materialized into adk-flair's keyfile
  by a boot shim registered through ADK's services.py channel; includes a
  verify chat helper, honest failure modes, and a full teardown path
  (#1228, #1229)
