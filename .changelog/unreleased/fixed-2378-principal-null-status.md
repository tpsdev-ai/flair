- **`flair principal show` and `principal list` report a principal's `status` the way the auth gate reads it (flair#2378).**
  An explicit `null` is deactivated and an absent `status` is active. Both call
  the gate's `isPrincipalDeactivated`; `list` reads the raw row, because a
  projected `status` comes back `null` for both an absent and an explicit-null
  column.
