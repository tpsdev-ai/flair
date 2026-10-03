- **REM nightly: a missing generative backend alone no longer fails the run** (#924, #1503).
  The no-backend skip requires the exact structured no-backend error and HTTP 503. In-flight `rem_aborted`
  pauses and idle ADK distillation are skips; preflight pause remains `paused` with no skips.
  Summaries print skips and errors; errors set exit 1. Agent-identity dedup failure remains #809.

  `Last distilled` is the newest distillation observed in the server's local nightly log tail;
  remote CLI logs are local to the CLI and are not observed there. Status shows zero pending
  beside it. Empty gathers, malformed responses and failed cycles do not stamp `distilledAt`.
  Maintenance counts are labelled (`Archived`: validTo-expired + old sessions;
  `Expired`: ephemeral rows past `expiresAt`).
