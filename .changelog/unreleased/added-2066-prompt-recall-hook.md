- **Claude Code can now recall Flair memories on every prompt, not only at session start.**
  The new `flair-prompt-recall` binary in `@tpsdev-ai/flair-mcp` is a `UserPromptSubmit` hook. It
  searches with the prompt (markup, URLs and long ids stripped, 500 characters at most), using the
  same hybrid search as the MCP `memory_search` tool and the agent's own Ed25519 key, and adds the
  hits that meet a relevance threshold as context: each with its id, date, score and a snippet,
  under a header that frames them as a signal to verify, not an instruction, and bounded to 2,000
  characters in all. A memory flagged by Flair's content scan is shown behind a fixed warning line
  that cutting the text to fit never removes. It skips background task notifications and short
  acknowledgements, exits 0 on every path, and when Flair is unreachable, slow or refuses the
  request it adds no memories, only one line saying recall was unavailable. The time budget runs
  from the hook's start and ends any asynchronous wait (the prompt on stdin, the config file, the
  search request and its response); the prompt and the config file are read with size caps, and
  after the Flair client returns, the hook examines a bounded number of results and characters. A
  response that has fully arrived is parsed, and every result in it converted, synchronously by the
  client before that; the budget cannot interrupt that step and the response size is not capped.
  The threshold (default 0.62), the number of memories (default 4) and the time budget (default
  3000 ms) come from `FLAIR_PROMPT_RECALL_MIN_SCORE`, `FLAIR_PROMPT_RECALL_MAX_HITS` and
  `FLAIR_PROMPT_RECALL_TIMEOUT_MS`, or from the matching top-level keys in `~/.flair/config.yaml`.
  The hook never uses admin credentials. It is opt-in and wired by hand: `docs/claude-code.md` now
  lists all three Claude Code hooks and gives the `settings.json` entry for this one, launched from
  a pinned local install so no package resolution runs ahead of every prompt.

  (Closes #2066)
