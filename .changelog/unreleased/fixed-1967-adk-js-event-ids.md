- **ADK JS stores events that have no id as separate records instead of overwriting one another.**
  The memory service gives an event with a missing or empty `id` a random UUID in its record id, as the Python package does; events with a non-empty `id` keep their deterministic `app:user:session:eventId` record id. The Python `FlairWriteError.status_code` is annotated as `int | None`.

  (Refs #1967)
