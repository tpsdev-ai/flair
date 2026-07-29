- **`flair init` no longer renumbers an instance that serves a custom port.** A
  bare `flair init` used to rewrite the port to 19926, because `--port` carried a
  commander default and commander cannot tell "the user passed the default" from
  "the user passed nothing". It was the only one of ~50 `--port` declarations in
  the CLI with a default, on the one command where a default is destructive:
  `init` is `flair doctor`'s standing suggestion and is recommended as the remedy
  in ten other places, so the command handed to an operator whose install was
  already wrong was the one that quietly moved their port.

  A bare `init` now resolves the port the way every other command does — explicit
  `--port`, then `FLAIR_URL`, then the port Harper records for that data
  directory, then the per-user config — and only reaches 19926 for a data
  directory no instance has ever been served from. An explicit `--port` still
  moves the instance, and a first-run `flair init` still lands on 19926.
