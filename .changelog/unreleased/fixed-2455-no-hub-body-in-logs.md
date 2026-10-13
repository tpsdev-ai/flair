- **Federation sync no longer logs the hub's response text; a failed batch, an invalid batch response and a failed liveness ping name the HTTP status.**

  A successful batch response is now checked before its counts are used: a
  body that is not JSON, or whose `merged` and `skipped` are not whole numbers
  from zero to the batch size, fails the sync as an invalid response, as a
  non-2xx batch already does.
