- **Presence refuses a keyless PUT/PATCH before it reaches the store.**

  An authenticated administrator's keyless PUT/PATCH gets 400
  `presence_target_required`; a non-admin agent's collection PUT/PATCH gets the
  owner guard's named 403; an anonymous request gets 401 (#2624).
