- **Memory PATCH validates a durability it sets.**
  An invalid durability on a PATCH is refused with `invalid_durability` before the stored row changes, as it already was on a create or a full replace.

  (Closes #1961)
