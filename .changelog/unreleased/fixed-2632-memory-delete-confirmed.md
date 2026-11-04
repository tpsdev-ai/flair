- **An ordinary, non-skill Memory DELETE confirms row removal before answering success.**

  It retries a removal that did not land and refuses exhausted attempts as
  `409 delete_not_applied` (#2632). The skill path closes the live head instead.
