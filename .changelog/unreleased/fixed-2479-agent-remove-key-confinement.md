- **`flair agent remove` checks each key's canonical target before unlinking (#2479).**
  An id outside the agent-ID rule now deletes no key file and reports that the cleanup is
  manual; `flair doctor`'s remedy text says the same.
