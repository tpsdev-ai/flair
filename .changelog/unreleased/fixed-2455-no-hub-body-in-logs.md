- **Federation sync no longer logs the hub's response text; an unrecoverable non-2xx batch or a non-2xx liveness ping names only its HTTP status.** (#2538)

  A batch of more than one record that gets a retryable status (408, 413, 502,
  503 or 504) or no response is split and retried in smaller batches, which can
  succeed; only a batch that does not recover fails the sync. Then a non-2xx
  status is reported as the status alone, and a transport failure (a timeout or
  a dropped connection, so no status) as the local error message, as before. A
  2xx batch response is now checked before its counts are used: a body that is
  not JSON, or whose `merged` and `skipped` are not whole numbers from zero to
  the batch size, fails the sync as an invalid response.
