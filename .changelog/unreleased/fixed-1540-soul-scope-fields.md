- **Soul writes that supply a non-empty `scopeTag` or a non-empty `tags` array are refused, and the replay writers report the refused row.**

  Soul has no dedicated or enforced per-user scope field. A write request that
  supplies a non-empty `scopeTag` or a non-empty `tags` array is refused by
  name, when earlier guards permit the request: HTTP 403 with
  `soul_scope_fields_not_writable`, for operator and internal writes on POST,
  PUT and PATCH. This scope-field check does not reject a PATCH that sets
  neither field, even when the row's stored data carries them. `flair restore`
  and `flair import` report a Soul row refused with this error, with the row's
  id (#1540).
