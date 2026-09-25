- **A local write on an instance with several Instance rows now stamps no originator identity instead of an arbitrary one, and says so once.**

  The write-time `originatorInstanceId` stamp resolves this instance's own
  identity from the `Instance` table for a local Memory, Soul, Agent or
  Relationship write that carries no originator yet; Message uses the same
  resolution for its org scope. It used to take the first row of an unordered
  search and cache it, so on an instance whose table holds several rows — a
  legacy install, or the state `flair init --remote`'s detected race leaves —
  those writes were stamped with an arbitrary identity, one peers may never have
  pinned. It now decides through the same shared rule the federation
  readers use:

  - one row → cached and returned, as before;
  - no row, or a read that fails → null, uncached, as before;
  - several rows → null, so the write stamps nothing.

  A null `originatorInstanceId` is the defined local-origin state, so the write
  still succeeds: the stamp does not throw (that would fail every local write on
  such an instance and could lose writes on upgrade) and does not pick a row.
  One error naming the row count and the prune remedy is logged per process, and
  the refusal is remembered for at most a minute, so a write in that state does
  not re-read the table every call and `flair federation instance prune` takes
  effect without a restart. The read goes through the same strict reader
  `GET /FederationInstance` uses, so an entry with no usable id is an unreadable
  read (null) rather than a smaller list.

  (Refs #1896)
