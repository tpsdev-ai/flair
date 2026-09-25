- **`flair init --remote` confirms the identity row it wrote, so an absent or wrong hub identity is never reported as reconciled.**

  The post-write re-read used to reject only a table holding several rows. A
  re-read that came back EMPTY (the insert never landed) or held one DIFFERENT
  row (the role update went elsewhere) verified as a success, and init went on to
  adopt `reconciled.id` — reporting a completed init for an identity the instance
  did not have. The re-read must now hold exactly one row: the one just written,
  with `role=hub`. Anything else fails the command and names the rows it found,
  because "the write did not land" and "the write landed on another row" want
  different operator responses.

  (Refs #1883)
