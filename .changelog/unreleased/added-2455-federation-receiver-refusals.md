- **The federation receiver names every offered record it refused and aborts an overrunning merge.**

  A `POST /FederationSync` batch response now carries `refused`: one entry per
  offered key the receiver refused, each with a reason from the closed
  `SkipReason` enum — retryable or not, and never free text. A merge that
  overruns a five-second per-record deadline is reported refused
  (`merge_error`) and its transaction is aborted for real, so it does not land
  after the receiver reported the key refused. The field is additive: a sender
  that reads only `merged`/`skipped` is unaffected.
