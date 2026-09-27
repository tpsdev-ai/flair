- **Python `search_memory` drops hits from a foreign agent id like listing, and the ADK READMEs now state only what ships.**
  `search_memory` now rechecks that each hit's `agentId` is this service's own agent identity, exactly as
  `list_memories` already did — the compound tag `adk:<app_name>:<user_id>` is a per-user RETRIEVAL FILTER,
  not an isolation boundary. The Python and JS READMEs now say: the client sets HTTPX phase timeouts with no
  enclosing wall-clock deadline; the service scopes reads and writes by the `app_name`/`user_id` it is given;
  an event with an id gets a deterministic record id while an event without one gets a fresh UUID; and the
  remote-URL opt-in is read from the environment only, not from a constructor argument.

  (Refs #1943)
