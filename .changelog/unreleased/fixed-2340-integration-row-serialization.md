- **An Integration `PUT`, `PATCH` or by-id `DELETE` that names a stored row re-reads the committed row before it commits.**
  When that row is no longer the row this attempt read, the write aborts and is
  retried from the committed row (bounded). A `POST` that names a row id, once
  its other checks pass, reads that row and refuses an existing one with
  `integration_row_exists` (409), writing nothing.
