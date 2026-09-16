- **A fresh launchd instance now applies owner-only socket permissions on first start, so `flair doctor` is green without a second restart.**

  `flair init` and `flair start` already tightened the data directory to `0700`
  and the operations socket to `0600` after Harper came up. Adopting that
  instance into launchd (`flair doctor --fix`) bounced it and left the new
  socket at Harper's default mode until the next start. The adopt path now
  re-applies the same posture once the launchd job is serving, matching
  restart. (Refs #1701)
