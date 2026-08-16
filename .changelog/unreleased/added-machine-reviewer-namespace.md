- **Reserved the `machine:` reviewer namespace for automated promotions.**
  Promotions record a `reviewerId` for audit and attribution. The `machine:`
  prefix (canonical `machine:adk-auto-promote`) is now reserved for
  machine-driven promotion paths so automated decisions can never be mistaken
  for a human or agent reviewer, and `flair rem promote --reviewer` refuses any
  value in that namespace.
