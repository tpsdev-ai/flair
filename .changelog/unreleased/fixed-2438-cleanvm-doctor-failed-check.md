- **The clean-VM CI gate reports `flair doctor` findings on failure (#2438).**
  When `flair doctor` exited non-zero the gate printed a fixed message blaming the
  embeddings showstopper, whatever doctor had actually counted. It prints `✗` findings
  when they account for doctor's issue count; otherwise it prints all `✗` and `⚠`
  findings, including their detail lines. It adds #538 detail when a `✗` finding
  contains `Semantic search DEGRADED`.
