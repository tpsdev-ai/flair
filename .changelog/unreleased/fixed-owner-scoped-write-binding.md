- **The owner-scoped write guard checks the body `id` of a non-admin agent's addressed write for every id type.**
  The owner-scoped write guard refuses a non-admin agent's addressed POST, PUT
  or PATCH whose body `id` is not a string or number and is not the addressed
  key with 400 `id_target_mismatch`, and checks each object element of an array
  body as it checks the body itself (#2551).
