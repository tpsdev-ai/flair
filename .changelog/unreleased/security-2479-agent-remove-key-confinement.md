- **`flair agent remove` confines automatic key-file deletion to the intended agent's canonical key paths (#2479).**
  For stored IDs ineligible for automatic key cleanup, the command reports manual cleanup
  when deletion was requested; `flair doctor` gives the same guidance.
