- **`flair reembed` changes only `embedding`, `embeddingModel` and `updatedAt`; other stored fields are kept (#2296).**
  It sends `PATCH /Memory/<id>` with
  `{"embedding": null, "embeddingModel": null}`; the server embeds the stored
  row and writes those three fields.
