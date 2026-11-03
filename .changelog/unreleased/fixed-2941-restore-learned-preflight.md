- **`flair restore --replace` checks the learned-content rule before it deletes anything.**

  The server refuses a Soul write whose `value` equals a same-agent Memory
  `content` or MemoryCandidate `claim`. Replace mode refuses the run when a
  non-empty archived Soul value equals the content of a live Memory row its
  deletes leave in place, or the claim of a live MemoryCandidate. A row either
  the scope-field or the learned-content rule would refuse stops the run before
  any delete and exits non-zero: a scope-field refusal names the archived Soul
  row and the archive-edit remedy, and a learned-content refusal names the Soul
  id, the matching Memory or candidate row and the remedy. A Memory DELETE the
  server refuses stops the run before any Soul row is deleted; a Memory the run
  already deleted, or whose DELETE outcome is unknown, is written back and
  verified when a later Memory DELETE fails, and a row that cannot be restored
  is reported by id. Restore DELETE and PUT requests refuse a redirect instead
  of following it: the run names the status and sends no request to the
  redirect location. A Memory or candidate
  listing that cannot be read refuses the run before any delete, when
  a non-empty archived Soul value requires that read; refusals already
  collected are printed before that error. A refused Soul write now
  reports the server's error name when the body carries one (#2941).
