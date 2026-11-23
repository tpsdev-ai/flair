- **Write-back checks staged values after commit, including omitted fields for full-row plans.**

  Post-commit mismatches retry only idempotent plans; non-idempotent plans end
  with an unconfirmed outcome (#2653). ([#2655](https://github.com/tpsdev-ai/flair/pull/2655))
