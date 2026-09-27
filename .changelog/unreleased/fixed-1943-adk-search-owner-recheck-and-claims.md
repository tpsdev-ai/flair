- **ADK search drops hits from a foreign agent id, and the ADK READMEs state only what ships.**
  Python `search_memory` and JS `searchMemory` now recheck that each hit's `agentId` is this service's own
  agent identity, as listing already did: the compound tag `adk:<app_name>:<user_id>` is a per-user
  RETRIEVAL FILTER, not an isolation boundary. The Python README describes HTTPX phase timeouts and its
  UUID fallback for events without ids; the JS README describes its `fetch` abort timer. Both READMEs say
  the service scopes reads and writes by the `app_name`/`user_id` it is given, that the remote-URL opt-in is
  read from the environment only, and that other ordinary agents cannot read a private memory while admins
  and trusted internal calls can.

  (Refs #1943)
