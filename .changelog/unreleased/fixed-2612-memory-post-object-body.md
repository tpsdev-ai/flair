- **A Memory `POST` whose body is not one JSON object is refused with a named 400
  `body_must_be_object` instead of an unnamed 500.** An array, `null`, a string or a
  number body now answers the named refusal before any write path runs, and stores
  nothing.
