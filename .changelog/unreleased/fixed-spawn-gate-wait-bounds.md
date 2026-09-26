- **The CLI spawn-budget gate's wait-bound rules are exact, closing the last classifier gaps (flair#1825).**

  A `fetch` is bounded only when its OWN options carry a real deadline: `signal:
  AbortSignal.timeout(<literal>)` where `<literal>` is a strict positive-integer
  literal, or an identifier that is `const`-declared in the same file to exactly
  that expression AND never reassigned (a `let`/`var`, or any second assignment, is
  unbounded). A bare `signal`, an unknown signal value, a deadline that merely
  appears later in the case, or a deadline the case reaches only by proximity does
  NOT count. Test: `test/unit/check-cli-spawn-budgets-gate-1825.test.ts` (round 6
  (a)/(b); round 7 item 3).

  A `timeout:` literal is the ONE strict token `[1-9][0-9]{0,14}(?:_[0-9]{1,3})*` —
  no leading zero, no leading/trailing/double underscore, at most 15 digits — and
  the SAME rule applies to spawn timeouts, case budgets and `AbortSignal.timeout`
  arguments alike: `0` is neither a spawn timeout nor a budget, and `1e999`,
  `10000-10000`, `1__000`, `_1000` and a 310-digit literal are all unknown →
  unbounded / no-budget. The count is of the digits AFTER underscores are removed,
  so `1_000_000_000_000_000` (19 digits) is unknown and `999_999_999_999_999`
  (15) is a deadline. A spawn's `timeout:` is read from the OPTIONS argument ONLY —
  an argv element never decides it. Tests: round 7 item 4; round 9 items 1-2.

  `fetch(` is a METHOD DEFINITION — and skipped — ONLY when the significant token
  before `fetch` is `{`, `,`, `;` or the keyword `async` (object-literal/class-body
  position) AND the `{` follows the closing paren on the same line; everything else,
  including `await fetch("x")` with a trailing block, is a call. Tests: round 7 item 1.

  A one-line function body contributes its waits exactly like a multiline one
  (test: round 7 item 2). A case with no explicit budget that reaches a CLI-entry
  spawn is an offender (test: round 7 item 5).

  (Refs #1825; further classifier gaps go to #1921.)
