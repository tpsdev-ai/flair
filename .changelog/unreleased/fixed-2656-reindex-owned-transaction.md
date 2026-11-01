- **The admin `_reindex` re-PUT commits its own transaction and reads the committed row back before answering success.**

  A `PUT /Memory/<id>` carrying `_reindex: true` no longer joins the request's
  transaction. After its commit it reads the row: a row that does not show the
  re-PUT answers `409 stored_row_changed`, and a failed read answers
  `503 write_outcome_unknown`. In v0.62.0 it joined the request's transaction
  and answered success without that read, so a same-id write committing
  between its last check and the request's commit could leave the stored row
  without the re-PUT while the re-PUT answered success.
