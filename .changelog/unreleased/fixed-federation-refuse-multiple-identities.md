- **A reader with several identity rows refuses instead of picking one, and a read that established nothing is not a read that found none.**

  The two paths a pairing peer pins from — `GET /FederationInstance`, and the hub
  identity in the `POST /FederationPair` response that a pairing spoke PINS as
  its hub peer — still reported the first row of an unordered search, so which
  identity they answered with depended on the table's own ordering. Both now
  answer a 409 that names every row and the prune that resolves them, and the
  pairing refusal happens BEFORE the one-time token is consumed, before the peer
  is read and before any peer is written: a refused pairing leaves the token
  usable and the table unchanged. (Two other server readers still take the first
  row of the table; that is a separate defect, tracked as flair#1896.)

  The prune's warning no longer names "the row the hub has been answering with"
  as the identity peers pinned — it cannot know which row a peer pinned. That
  value came from the `POST /FederationPair` response, which WAS the first row of
  the search while several rows existed (it is a 409 now), so any row being
  deleted may be the identity a peer paired before this fix pinned, and such
  peers must re-pair.

  A 200 from the ops API whose body is not a row list — invalid JSON, or a shape
  the reader does not know — was read as zero rows, so `flair init --remote` could
  create an identity on a read that established nothing, and `flair doctor` could
  report "no rows" for a table it never saw. Unreadable is its own outcome and
  follows the failed-read path: it throws, and only a successful read of zero rows
  may create. The same holds for a row the reader cannot name (an entry with no
  usable id): dropping it would read the table as "the rows I could name", so the
  whole read is unreadable and `flair doctor` reports UNVERIFIED rather than
  "no rows".

  (Refs #1883)
