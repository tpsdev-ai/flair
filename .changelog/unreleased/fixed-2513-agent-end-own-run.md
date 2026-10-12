- **`agent_end` keys its captures by message identity and keeps a failed write's original run (#2513).**

  `agent_end` receives the whole session's message snapshot, and the previous release
  rescanned it on every run, storing duplicates of messages an earlier run had
  captured under the new run's id. The capture path now gives each snapshot message a
  stable identity (its role, content and its own timestamp) and skips a message whose
  identity it has already recorded, so a later run does not store a message an earlier
  run already handled nor attribute it to itself. A write that fails is recorded as
  pending with its run's id and retried under that id by a later callback. Each
  session's identity state is bounded; `captureBounds` states the caps and what
  eviction means.
