- **The CLI spawn-budget gate's wait-bound rules are now exact, closing four live false acceptances (flair#1825).**

  A `fetch` is bounded only when its OWN options carry a real deadline —
  `signal: AbortSignal.timeout(<positive integer literal>)`, or an identifier that
  resolves in the same file to exactly that expression. A bare `signal: new
  AbortController().signal`, a `signal` of unknown value, or an `AbortSignal.timeout`
  that merely appears later in the case no longer counts. Every helper a case reaches
  contributes its waits, spawn or not. A `timeout:` literal must be the exact token
  `[1-9][0-9]*` — `1e999`, `10000-10000` and `0` are NOT deadlines and leave the spawn
  unbounded.

  (Refs #1825)
