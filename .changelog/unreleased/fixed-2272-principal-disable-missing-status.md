- **`flair principal disable` and `enable` treat a principal with no stored `status` as active.**
  Such a principal (created through an agent seed, or by a seed written before the
  field existed) can be disabled and re-enabled: disabling refuses its protected
  authenticated requests, and re-enabling restores access. Human-readable
  `flair principal list` and `show` output reports the missing status as active (flair#2272).
