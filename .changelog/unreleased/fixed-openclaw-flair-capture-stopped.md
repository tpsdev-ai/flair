- **A callback that arrives during shutdown is refused, so no capture write starts after `gateway_stop`.**

  `gateway_stop` aborts every in-flight run and clears the run map so its records
  stop being reachable — but a callback arriving after the clear found no record
  and was ADMITTED as a new run: the same failed-run re-admission the abort
  tombstones exist to prevent. With the sweep timer stopped as well, nothing was
  left to retire that record, so the run could capture again and start a write
  after the abort.

  The stop now sets a flag FIRST, before the aborts and before the clear, and the
  capture gate refuses every callback while it is set: a late `llm_input`,
  `llm_output` or `agent_end` is dropped with one log line, admits no record and
  starts no write. A later registration builds a new map and its own gate, so the
  flag needs no clearing.

  (Refs #1751)
