- **A Presence write that names no agent is refused by name instead of reaching the store.**

  A PUT or PATCH whose target is absent from both the URL and the body answers
  `presence_target_required` with a 400, before the owner and home checks and
  before any read-modify-write, for the administrator as well (#2624).
