- **An OrgEvent write whose body is not a JSON object is refused with the named 400 `body_must_be_object`.**

  POST, PUT and PATCH of `/OrgEvent` take a JSON object body; a collection PUT
  takes an array of such objects. A body that is a string, a number, a boolean,
  null, or an array of non-objects is refused with `body_must_be_object` (400)
  before any other check, and nothing is written.
