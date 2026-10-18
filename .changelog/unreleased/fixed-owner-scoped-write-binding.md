- **A non-admin agent's addressed owner-scoped write commits only to the record its ownership checks read, for every accepted id shape.**
  The owner-scoped write guard refuses an addressed POST, PUT or PATCH whose
  body `id` is not a string or number and is not the addressed key with 400
  `id_target_mismatch`, and checks each object element of an array body as it
  checks the body itself (#2551).
