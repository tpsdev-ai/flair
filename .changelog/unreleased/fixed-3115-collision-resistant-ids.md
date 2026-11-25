- **`flair quality --emit` and the hermes-flair client give each stored memory a random-suffix id.**
  Both used the agent id plus the current millisecond, so two writes in the same
  millisecond reached the same `PUT /Memory/<id>` and the upsert kept one row.
  The quality snapshot keeps its `-quality-snapshot-` prefix and ends in a UUID;
  the hermes-flair client's `flair_store` id ends in a UUID too.
