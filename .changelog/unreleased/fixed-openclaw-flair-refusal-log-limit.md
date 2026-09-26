- **Callback refusals are logged once per agent, and the capture-off guarantee
  says what it actually means.**

  A callback with a valid identity but no usable key used to log the same refusal
  line on every occurrence — `agent_end`, `llm_input`, `llm_output`, and the
  prompt hook's recall read. Those lines now go through the bounded one-time path,
  keyed by the agent they refused: one line per agent, however many callbacks
  arrive. The refusals themselves are unchanged, and each still makes no outgoing
  request.

  The plugin README's "capture is off by default" guarantee no longer claims zero
  reads. With `autoCapture` unset no capture hook is registered and no capture
  write happens, however the turn runs; recall is a separate feature, and its own
  hook may still make a bootstrap read. The test cited for that guarantee now
  proves the claim it makes.

  (Refs #1751)
