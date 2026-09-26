- **A reader with several identity rows refuses instead of picking one, and a read that established nothing is not a read that found none.**

  The two paths a pairing peer pins from — `GET /FederationInstance`, and the hub
  identity in the `POST /FederationPair` response that a pairing spoke PINS as
  its hub peer — still reported the first row of an unordered search, so which
  identity they answered with depended on the table's own ordering. Both now
  answer a 409 naming the prune that resolves them. `GET /FederationInstance`
  (admin only) also names every row. `POST /FederationPair` is public and
  refuses before the pairing token or a re-pairing peer's key is checked, so
  its answer names no row, and the hub's log carries each row's id, role and
  created time. The pairing refusal
  happens BEFORE the one-time token is consumed, before the peer is read and
  before any peer is written: a refused pairing leaves the token usable and the
  table unchanged. (Two other server readers still take the first
  row of the table; that is a separate defect, tracked as flair#1896.)

  The prune's warning says that any row being deleted may be the identity a
  paired peer pinned, and that such peers must re-pair. It cannot know which row
  a peer pinned: while several rows existed, `POST /FederationPair` answered
  with the first row of an unordered search (it is a 409 now), so a peer that
  paired in that state may have pinned any of them.

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
