- **A reader with several identity rows refuses instead of picking one, and a read that established nothing is not a read that found none.**

  The two server paths that answer with this instance's identity — `GET
  /FederationInstance`, and the hub identity in the `POST /FederationPair`
  response that a pairing spoke PINS as its hub peer — still reported the first
  row of an unordered search, so which identity they answered with depended on
  the table's own ordering. Both now answer a 409 that names every row and the
  prune that resolves them, and the pairing refusal happens BEFORE the one-time
  token is consumed and before any peer is written: a refused pairing leaves the
  token usable and the table unchanged.

  The prune's warning no longer names "the row the hub has been answering with"
  as the identity peers pinned — it cannot know which row a peer pinned (that is
  the `POST /FederationPair` response, which is the first row of the search when
  several exist). It says what is true: any row being deleted may be the identity
  a paired peer pinned, and such peers must re-pair.

  A 200 from the ops API whose body is not a row list — invalid JSON, or a shape
  the reader does not know — was read as zero rows, so `flair init --remote` could
  create an identity on a read that established nothing, and `flair doctor` could
  report "no rows" for a table it never saw. Unreadable is its own outcome and
  follows the failed-read path: it throws, and only a successful read of zero rows
  may create.

  (Refs #1883)
