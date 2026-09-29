- **Claude Code can now recall Flair memories on every prompt, not only at session start.**
  The new `flair-prompt-recall` binary in `@tpsdev-ai/flair-mcp` is a `UserPromptSubmit` hook. It
  searches with the prompt (markup, URLs and long ids stripped, 500 characters at most), using the
  same hybrid search as the MCP `memory_search` tool and the agent's own Ed25519 key, and adds the
  hits that meet a relevance threshold as context: each with its id, date, score and a snippet,
  under a header that frames them as a signal to verify, not an instruction, and bounded to 2,000
  characters in all. It skips background task notifications and short acknowledgements, exits 0 on
  every path, and when Flair is unreachable, slow or refuses the request it adds no memories, only
  one line saying recall was unavailable. The threshold (default 0.62), the number of memories
  (default 4) and the time budget (default 3000 ms) come from `FLAIR_PROMPT_RECALL_MIN_SCORE`,
  `FLAIR_PROMPT_RECALL_MAX_HITS` and `FLAIR_PROMPT_RECALL_TIMEOUT_MS`, or from the matching
  top-level keys in `~/.flair/config.yaml`. The hook never uses admin credentials. It is opt-in and
  wired by hand: `docs/claude-code.md` now lists all three Claude Code hooks and gives the
  `settings.json` entry for this one.

  (Closes #2066)
