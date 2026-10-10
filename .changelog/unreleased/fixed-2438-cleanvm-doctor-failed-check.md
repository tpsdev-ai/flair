- **The clean-VM CI gate reports the `flair doctor` finding that failed, not always embeddings (#2438).**
  When `flair doctor` exited non-zero the gate printed a fixed message blaming the
  embeddings showstopper, whatever doctor had actually counted. It now prints the finding
  lines doctor counted — the `✗` lines and any counted `⚠` warning — with the lines doctor
  prints under them. When doctor prints `Semantic search DEGRADED`, the gate also names the
  #538 showstopper; other failures, including other embeddings failures, are listed as
  doctor printed them.
