- **adk-flair: pre-built ADK agent tools — `create_flair_tools()`**
  (flair#1331). One factory call returns three ready-to-use async tool
  functions — `store_memory(subject, description, tags, custom_metadata)`,
  `search_memory(query, limit)` and `list_memories(limit, offset)` — bound to
  one `FlairMemoryService` and one `app_name`/`user_id` scope, ready to pass
  straight to `LlmAgent(tools=...)` (ADK wraps bare async callables in
  `FunctionTool` and generates the Gemini declarations from the signatures
  and docstrings). Explicit injection only: no env-var discovery, no service
  registry, no ambient identity — the scope binds at factory time so the
  model can never choose whose memory it touches, and scope parameters never
  appear in any tool declaration. `subject` flows through the first-class
  subject column; `tags` are stored inside `custom_metadata["tags"]`
  (round-trip labels, deliberately never written to the record's scope-tag
  array); results come back as plain JSON-serializable dicts with `subject`
  hoisted alongside `content`, `author`, `timestamp` and `custom_metadata`;
  failures the model can act on return as `{"error": ...}` instead of
  raising. +32 hermetic tests (134 vs 102 baseline, incl. a
  declaration-generation smoke test against the installed google-adk) and
  +2 live (tool-level store→search→list round-trip, cross-user scope
  isolation).
