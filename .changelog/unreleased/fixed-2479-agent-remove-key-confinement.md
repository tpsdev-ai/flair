- **`flair agent remove` deletes key files only inside the keys directory and only for the removed agent id (#2479).**
  An id outside the agent-ID rule now deletes no key file and reports that the cleanup is
  manual; `flair doctor`'s remedy text says the same.
