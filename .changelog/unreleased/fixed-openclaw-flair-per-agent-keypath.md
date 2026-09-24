- **openclaw-flair no longer mistakes an explicit keyPath for a shared OS user on a multi-agent gateway.**

  With an explicit `keyPath` and a single allowed agent, every other roster agent
  was resolved against that same key, so the shared-OS-user gate refused a
  configuration the design sanctions — and reported the wrong reason. Each agent
  now resolves its OWN key (the explicit `keyPath` applies only to the allowed
  agent), and the "keyPath needs a single allowed agent" refusal is reported
  before the readability check. The out-of-set-host and shared-user refusals now
  also pin services and context engines to zero, so "registers nothing" covers
  every registration surface.

  (Refs #1751)
