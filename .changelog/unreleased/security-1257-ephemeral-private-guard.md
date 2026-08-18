- **Ephemeral memories are now private-only, enforced server-side.** `ephemeral`
  is the continuity-journal tier (auto-captured working state, self-pruning);
  its durability-keyed default visibility was already `private`, but a default
  is not a constraint — an explicit `visibility:"shared"` on an ephemeral write
  was accepted, which would have made journal entries org-readable and
  federation-pushed. `Memory.post()` and `Memory.put()` now refuse the
  combination with 400 (`invalid_visibility_for_durability`), including a PUT
  that flips a stored ephemeral row to `shared` without naming a durability of
  its own. Promoting a row out of `ephemeral` (e.g. distillation lifting it to
  `persistent`) while sharing it in the same write remains allowed. (flair#1257)
