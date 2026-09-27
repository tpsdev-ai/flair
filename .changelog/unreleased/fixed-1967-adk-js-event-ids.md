- **ADK JS stores events that have no id as separate records instead of overwriting one another.**
    The memory service gives an event without an `id` a random UUID in its record id, as the Python package does; events with an `id` keep their deterministic `app:user:session:eventId` record id. The Python `FlairWriteError.status_code` is annotated as `int | None`.

     (Refs #1967)
