- **The unit lane's time budget no longer kills a late step on the CI runners that exhausted the old 510 s
  budget.** The budget is sized to the lane's measured length with headroom, so a step is not failed only because an
  earlier one ran long on a slow runner. Per-step limits still kill a hung step fast and name it.
