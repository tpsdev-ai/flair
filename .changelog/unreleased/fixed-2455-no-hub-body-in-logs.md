- **Federation sync no longer logs the hub's response text; a non-2xx batch or liveness ping now names only its HTTP status.**

  A transport failure (a timeout or a dropped connection, so no response and
  no status) reports the local error message, as before. A 2xx batch response
  is now checked before its counts are used: a body that is not JSON, or whose
  `merged` and `skipped` are not whole numbers from zero to the batch size,
  fails the sync as an invalid response, as a non-2xx batch already does.
