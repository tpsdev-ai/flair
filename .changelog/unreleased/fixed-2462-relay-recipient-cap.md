- **A relay send serializes the recipient-wide inbox cap per recipient within one Harper process, so concurrent senders cannot together exceed it (flair#2462).**

  A `POST /Message` counted a recipient's pending messages and then stored the
  new one without serializing that read against another sender's write, so
  several different senders delivering to one recipient at once could each see
  room and together overshoot `FLAIR_RELAY_INBOX_CAP`. The send now holds a
  per-recipient lock across the count and the store, taken after the message-id
  lock and before the per-sender lock; a send that cannot take it is refused,
  as flair#2461 already does for the per-sender cap and the thread sequence, and
  every write commits before the lock releases. Coordination is within one
  Harper process.
