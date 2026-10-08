- **`flair principal show` and `principal list` report a cleared `status` as deactivated (#2378).**
  Both call the auth path's own `isPrincipalDeactivated` predicate instead of a
  `?? "active"` fallback, so an explicit `null` — the shape the operations API
  materialises for a cleared column — displays as deactivated, while an absent
  `status` still displays as active.
