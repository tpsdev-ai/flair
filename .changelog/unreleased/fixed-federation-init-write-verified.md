- **`flair init --remote` confirms the identity row it wrote, so an absent or wrong hub identity is never reported as reconciled.**

  `flair init --remote` used to write its hub identity row blind: it inserted the
  row and went on. It now re-reads after the write, and that read must hold
  exactly one row — the one just written, with `role=hub`. A re-read that comes
  back EMPTY (the insert never landed) or holds one DIFFERENT row (the role
  update went elsewhere) fails the command and names the rows it found, because
  "the write did not land" and "the write landed on another row" want different
  operator responses.

  (Refs #1883)
