- **`scripts/flair-client.mjs` now honours `--limit` on search.** The flag was never
  parsed, so it and its value fell through into the query string: searching with
  `--limit 20` searched for the literal text "<query> --limit 20" and still returned
  the hardcoded 5 results. A non-numeric value is now rejected rather than ignored.
