- **An `agent_end` capture now keeps a per-session settled-through mark, so a re-delivered message is not stored again after its identity is evicted (#2560).**

  A session's `agent_end` scan remembers the greatest message timestamp it has
  settled. A message at or below that mark whose identity the session has
  evicted is not captured again; the bounded identity set still decides copies
  it holds. The
  ordering key is the host's message `timestamp` (a millisecond number) that the
  pinned host stamps for transcript ordering; a message that carries no
  numeric timestamp has no ordering key and relies on the bounded identity set
  alone. The wording on the overflow paths is qualified the same way: a
  queue-overflow disable and the abort overflow log once per retained key and
  hold only while the session's state is held.
