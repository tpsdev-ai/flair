- **`originatorInstanceId` is server-stamped on every write: a create stamps the local id, an update keeps the stored value.**

  `originatorInstanceId` names the federation instance that authored a record and
  the schema has always documented it as server-stamped and never
  client-writable, but each synced resource only stamped it when the request
  body's value was null (`== null`). A caller could therefore supply or change
  the field on both create and update.

  Now a **create** (`post()`, or a `put()`/`patch()` onto a row with no stored
  counterpart) stamps this instance's own id and ignores any request-body value;
  an **update** keeps the stored value — a body value neither replaces nor clears
  it, and an update that omits the field leaves it. A row written before this
  release that carries no value stays without one on a later update (the field is
  additive, never invented on update). `PATCH` bodies can no longer set it
  either. Applies to `Memory`, `Soul`, `Agent` and `Relationship`
  (one shared delegate, `resources/originator-instance.ts`).

  The federation merge path is unchanged: a synced row's originating instance id
  is preserved because the merge applies rows through the raw table handle, never
  through a resource's write method, so no request body is consulted.

  > **Heads-up:** if a client or script relied on setting `originatorInstanceId`
  > through `POST`/`PUT`/`PATCH`, that value is now ignored — the server stamps
  > it. Nothing else about the field changed.
