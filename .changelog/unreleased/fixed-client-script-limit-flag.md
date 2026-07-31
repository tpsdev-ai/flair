- **`scripts/flair-client.mjs` no longer folds an unparsed flag into free text.**
  `search` accepted `--limit` but never parsed it, so the flag and its value became
  part of the query — `--limit 20` searched for the literal text "<query> --limit 20"
  and still returned the hardcoded 5 results. Flags are now extracted before the free
  text is assembled, and a flag with no value, an invalid value, or one belonging to a
  different command is a hard error rather than silently becoming content.
