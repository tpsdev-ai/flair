- **OrgEvent rejects malformed ids that reach validation with 400 `invalid_event_id`.**

  A collection PUT element whose `id` was an empty array or an object reached the
  table write, which answered a bare 500 ("Zero length key is not allowed" /
  "Unable to serialize object as a key"); a boolean id answered Harper's own 400.
  After POST normalization (an empty root id gets a generated id) and earlier
  guards (a non-admin collection PUT gets 403 first), POST, PUT and PATCH refuse
  ids outside a non-empty string or a non-empty array of strings with the named
  400 before any write. Trusted server-originated internal PUT/PATCH skip the id
  check in _assignCreatedAt. The refusal echoes no submitted value.
