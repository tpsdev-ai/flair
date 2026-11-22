- **Soul replay writers report the refused row.**

  Soul has no dedicated or enforced per-user scope field. A write that would
  store a non-empty `scopeTag` or a non-empty `tags` array is refused by name,
  when earlier guards permit the request: HTTP 403 with
  `soul_scope_fields_not_writable`, for operator and internal writes on POST,
  PUT and PATCH. POST and PUT check the request body; PATCH checks the merged
  row. `flair restore` and `flair import` report a Soul row refused with this
  error, with the row's id (#1540).
