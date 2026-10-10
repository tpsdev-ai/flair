- **The clean-VM CI gate reports the `flair doctor` finding that failed, not always embeddings (#2438).**
  When `flair doctor` exited non-zero the gate printed a fixed message blaming the
  embeddings showstopper, whatever doctor had actually counted. It now prints the finding
  lines doctor counted — the `✗` lines and any counted `⚠` warning — with their `Fix:`
  lines, and names the embeddings showstopper when the embeddings check is the one that
  failed; a run that cannot be attributed to a check falls back to listing doctor's own
  lines rather than asserting a cause.
