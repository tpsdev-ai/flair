- **`@tpsdev-ai/n8n-nodes-flair` declares its `@langchain/classic` peer as `>=1.0.0 <2` (previously `*`).**
  A packed-install test loads `FlairChatMemory`, saves a turn and reads it back through the host's
  memory calls at `@langchain/classic` 1.0.0 with `@langchain/core` 1.0.0 and at 1.0.55 with
  `@langchain/core` 1.3.0, without `--legacy-peer-deps`.
