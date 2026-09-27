- **Fixed six OpenClaw integration and config claims the code contradicts.**

  Replaced the config block with the working ``openclaw-flair`` package shape
   (````memory``` ```slots``` and ``hooks.allowPromptInjection```); added
   ``agentId``` as an optional allow-list only. Clarified that
   ``memory_search``` returns bootstrap context (not a token budget),
   requires ``allowPromptInjection``` opt-in and runs at prompt build
  (no topic filter). The adaptive recent window widens to 7d and 30d
   rather than clamping to last 24h. A verified agent can read all its
  own records (private included) and other agents' non-private records --
  grants do not expand that scope. Writes carry an agentId field (tags
  are optional). For each resolved home, ``.flair``` then ``~/.tps/...``
  are checked before moving to the next. Host workspace files load
  ``SOUL.md`` not Flair.