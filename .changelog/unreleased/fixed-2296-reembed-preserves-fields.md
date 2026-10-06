- **`flair reembed` changes only `embedding`, `embeddingModel` and `updatedAt`; other stored fields are kept (#2296).**
  In 0.59.0 it rewrote each row with a `PUT` carrying only `id`, `content` and
  `agentId`, so fields such as `subject`, `tags` and `durability` were lost and
  `createdAt` was reset. It now sends `PATCH /Memory/<id>` with
  `{"embedding": null, "embeddingModel": null}`; the server embeds the stored
  row and writes those three fields.
