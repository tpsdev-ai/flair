- **`flair init`'s ops-API seed no longer retries away a real error when a non-OK response's body read stalls.**

  The bounded retry treated an owned body-read timeout as retryable regardless of
  the response status, so a 401 whose body stalled was retried — and if attempt
  2's body also stalled, the caller saw "timed out on both attempts" instead of
  the auth error. Every non-OK response was affected the same way. A body-read
  timeout is now retryable ONLY for an OK response (a 2xx whose body stalled is
  our stall); for a non-OK response the status is the answer, so it falls through
  to the status handling (401 → the auth error first, then 409/duplicate).

  (Refs #1790)
