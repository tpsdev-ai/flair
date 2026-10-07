- **`flair principal disable` and `enable` treat a principal with no stored `status` as active.**
  Such a principal (created through an agent seed, or by a seed written before the
  field existed) can be disabled and re-enabled: disabling stops its signed
  requests, and re-enabling restores them. `flair principal list` and `show`
  report the missing status as active (flair#2272).
