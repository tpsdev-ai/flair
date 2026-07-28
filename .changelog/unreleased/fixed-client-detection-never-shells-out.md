- **`flair init` no longer stalls for seconds detecting MCP clients, and no longer
  reports a client that is not installed.** Detection asked `npm list -g <pkg>`
  whenever a client's binary was not on PATH. That call walks the entire global
  package tree — around 0.8 s each on a warm machine, with no timeout — and
  `flair init` made up to three of them, so anyone without Claude Code, Codex and
  Gemini installed waited on a silent multi-second probe during first-run setup.

  It was also answering the wrong question. `npm list -g <pkg>` exits 0 when the
  package appears anywhere in the global tree, including as a transitive
  dependency of an unrelated global tool, and Gemini was probed with
  `@google/generative-ai` — a library, not the CLI. Flair could therefore report
  Gemini "detected" and write `~/.gemini/settings.json` on a machine with no
  `gemini` binary. In the other direction it assumed npm's default global prefix,
  so it reported "not installed" for mise / fnm / nvm / volta users.

  All four clients are now detected the same way, by looking for their executable
  on PATH, with no subprocess at all. Nothing installed is missed: `npm install
  -g` links a package's binary into the prefix's bin directory, which is on PATH
  by construction. A client whose binary is not on PATH could not be launched
  anyway, and `flair init --client <name>` still wires one explicitly without
  consulting detection.
