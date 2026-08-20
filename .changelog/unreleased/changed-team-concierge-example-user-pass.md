- team-concierge example: every comment now teaches the pattern — internal
  issue numbers, reviewer names, and version-publishing history removed from
  the README, agent, verify scripts, and GCP runbook. Dependencies pin the
  published release (`adk-flair>=0.46.0`) and the quickstart installs from
  PyPI; the runbook's operational caveats were re-verified against the
  published 0.46.0 CLI (one corrected: re-running `flair agent add` on an
  existing id reports success but keeps the old public key — it does not
  refuse).
