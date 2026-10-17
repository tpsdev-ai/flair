- **An OrgEvent write refuses a malformed record id with the named 400 `invalid_event_id`.**

  A collection PUT element whose `id` was an empty array or an object reached the
  table write, which answered a bare 500 ("Zero length key is not allowed" /
  "Unable to serialize object as a key"); a boolean id answered Harper's own 400.
  One shared id rule now answers across the OrgEvent write paths — POST, PUT (a single
  record and each element of a collection array) and PATCH — refusing an id that
  is not a non-empty string or a non-empty array of strings with the same named
  400, before anything is written. The refusal echoes no submitted value.
