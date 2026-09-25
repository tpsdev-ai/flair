- **openclaw-flair: an identity-less callback now warns once per callback source, not once per callback.**

  A host that keeps delivering `agent_end` / `llm_input` / `llm_output` without an
  agent identity used to produce one warning line per delivery — an unbounded run
  of identical lines about a host the plugin already refuses. Those lines now go
  through the plugin's bounded one-time log, keyed by the callback source, so at
  most one line is written per hook however many identity-less callbacks arrive.
  The refusal itself is unchanged: no identity still makes zero requests, and
  nothing is inherited from the environment.

  The plugin README's auto-capture guarantees now state each claim once, with the
  test that proves it: the best-effort bound sits inside the abort/retention claim
  it qualifies rather than beside it, the per-run claim is proven by two tests
  that fail if the session cap or the dedup set is shared across two concurrent
  runs of one agent and if a write is signed by an agent other than the one whose
  callback produced it, and the retention claim is proven just inside the
  retention minimum, not only past it.

  (Refs #1884)
