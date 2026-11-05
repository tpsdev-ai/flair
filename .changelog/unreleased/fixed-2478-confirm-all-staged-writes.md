- **A locked memory transaction runs every staged write's post-commit confirmation, even when an earlier confirmation throws.**

  Each staged write's confirmation resumes that write's body and opens its
  gate; a body whose confirmation throws no longer stops the confirmations
  that follow it. The transaction still fails with the first thrown error,
  after every confirmation has run, so a committed write is not reported as
  not committed (#2478).
