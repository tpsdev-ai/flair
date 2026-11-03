- **`flair restore --replace` checks the learned-content rule before it deletes anything.**

  The server refuses a Soul write whose `value` equals a same-agent Memory
  `content` or MemoryCandidate `claim`. Replace mode refuses the run when a
  non-empty archived Soul value equals the content of a live Memory row its
  deletes leave in place, or the claim of a live MemoryCandidate. A row either
  the scope-field or the learned-content rule would refuse stops the run before
  any delete, exits non-zero and names the Soul id, the matching row and the
  remedy. A listing that cannot be read refuses the run before any delete. A
  refused Soul write now reports the server's error name when the body carries
  one (#2941).
