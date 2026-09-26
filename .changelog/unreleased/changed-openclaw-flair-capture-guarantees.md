- **Capture-guarantee tests now cover every callback each README sentence names, and an abort during shutdown records nothing for an unknown run.**

  The openclaw-flair capture tests now drive the paths their README guarantees
  name: the per-run signing test writes from `llm_input`, `agent_end` and
  `llm_output` for interleaved agents and checks each write is signed by the
  agent whose callback produced it; the post-abort drop tests cover a callback
  after a `model_call_ended` abort and after `gateway_stop`, not only a failed
  `agent_end`; and the overflow case shows the documented best-effort residual —
  an abort of a never-admitted run records nothing, evicts no live record, and
  that run's next callback is admitted once room frees.

  `abortRun` also gets a guard: while `gateway_stop` has stopped the
  registration, an abort for a run the registry never saw records nothing and
  returns after the rate-limited line.

  (Refs #1892)
