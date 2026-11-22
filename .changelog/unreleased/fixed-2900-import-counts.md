- **`flair import` counts a row as imported only when its write returned a 2xx response.**
  A row whose write returns any other status, except a Soul scope-field refusal (HTTP 403
  for a row that supplies scope fields), is counted as failed and reported with its id,
  HTTP status and a recognized write-guard error name, when present; a run with a failed row and no unknown
  outcome exits 1.
  A write with no answer before its deadline is an unknown outcome, reported and exited 3.
  Non-connect-phase fetch failures and failed reads of successful write responses are also
  unknown outcomes. Recognized connect-phase failures are reported as failed rows.
  ([#2919](https://github.com/tpsdev-ai/flair/pull/2919))
