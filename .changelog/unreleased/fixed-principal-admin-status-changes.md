- **Changing a principal's admin status is restricted to administrators on every
  HTTP verb.** The principal table's per-record rules — you may only modify your
  own record, and only an administrator may change admin status — were enforced
  on one write path and not on the partial-update path, which reached the table
  with only a "is this a verified agent" check. Both paths now share one
  authorization helper, and a change to a principal's admin status is refused
  for a non-administrator on either. In-process maintenance and administrators
  are unaffected.
