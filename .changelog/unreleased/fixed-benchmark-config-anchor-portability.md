- **The benchmark config anchor now refuses non-portable numbers instead of silently breaking outside verification.**
  A float — or `NaN`/`Infinity`, or an integer past 2^53 — entering the
  pinned benchmark configuration now fails immediately, naming the offending
  field and the fix: pin it as a string (`"0.95"`) or a scaled integer (`95`).
  Previously such a value was hashed without warning, so the reported config
  hash could silently stop being re-derivable by anyone verifying it outside
  JavaScript — and a hash mismatch there reads as tampering. The anchor is now
  portable by design, not by accident. Already-published hashes and artifacts
  are unaffected. (Refs #1365)
