- **Soul writes that supply `tags` or `scopeTag` are refused, and the replay writers report the refused row.**

  Soul is scoped to an agent and its schema has neither column, so a supplied
  scope cannot be recorded there. A `tags` array or `scopeTag` outside the
  `adk:` prefix the dated bridge refuses is refused by name: HTTP 403 with
  `soul_scope_fields_not_writable`, for operator and internal writes on POST,
  PUT and PATCH. The refusal reads the fields the request supplies, so a PATCH
  that sets neither field still succeeds on a row whose stored data carries
  them. `flair restore` and `flair import` name a refused Soul row and the
  error instead of counting it restored (#1540).
