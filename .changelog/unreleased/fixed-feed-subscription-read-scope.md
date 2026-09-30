- **Memory and soul feed subscriptions apply the subscriber's read scope.**
  A non-admin agent subscribed to `FeedMemories` receives a memory only when the
  ordinary Memory read rule allows it: its own records at any visibility, plus
  other agents' non-private records. With the pinned Harper, the rule is
  applied to the full stored row through Harper's subscription row filter, for
  the records replayed when the subscription opens and for every live change.
  A second check in the subscription loop delivers only `put` and `invalidate`
  events whose value is an object. It decides from the event's own `agentId`
  and `visibility` when both are present, and otherwise from the stored row
  re-read by id, withholding the event when it has no id or when that read
  fails or returns no owner. Delete events are not delivered to a filtered
  subscriber. Verified agents can subscribe to the memory feed, and anonymous
  subscribers are refused. `FeedSouls` already follows the Soul read rule (any
  verified agent reads every soul), and the same tests now cover it. Admin and
  trusted internal subscribers are unchanged.

  `POST /FeedMemories` writes do not take the durability-keyed visibility
  default that `Memory.post()` and `Memory.put()` apply. A new `ephemeral` feed
  record without `visibility` lands `private`; any other new feed record
  without `visibility` has no visibility field, which reads as non-private; an
  update that names no visibility keeps a stored `private`/`shared` value. The
  feed's write response is the stored record, so it names `visibility` only
  when the record has one. The 0.33.0 entry "Every memory write now reports
  the visibility it landed on" describes the write response of `Memory.post()`
  and `Memory.put()` (the calls behind `memory_store`, `flair memory add` and
  the SDK writes), apart from the admin-only `_reindex` re-PUT.
