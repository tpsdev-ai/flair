- **The downgrade lane could only ever observe a hang, because the old binary was waiting for
  someone to type "yes".** Starting an older Harper against a store written by a newer minor calls
  `forceDowngradePrompt()`, which asks whether to proceed and **blocks on stdin**. The prompt and
  its accompanying version warning are written to stdout only — never to the log — so in CI the
  process simply stopped, with nothing in the output explaining why.

  The lane classified that correctly as a hang (the outcome the invariant forbids), but it meant the
  other two branches were untestable: the check could never distinguish "the old binary boots
  cleanly" from "the old binary refuses loudly", because it never got past the prompt to find out.
  An invariant naming three outcomes was being enforced against one.

  Both enforcement points now set `CONFIRM_DOWNGRADE=yes`, which pre-answers the prompt. The
  exit-124 hang check is deliberately kept — a hang that survives the override is a genuine hang and
  still fails the lane, now with a message saying the known prompt cause has been ruled out.

  The value must be lowercase `yes` or `y`: Harper tests membership in an allowlist behind a
  case-sensitive pattern, and the prompt library **discards an override that fails validation and
  falls through to reading stdin** — so `YES`, `true`, `1` or a trailing space reproduce the exact
  hang this avoids. Measured against harper 5.1.22 with prompt 1.3.0.

  Filed upstream as HarperFast/harper#2046; the migration itself is additive and reversible, which
  is the opposite of what the silent hang suggested.
