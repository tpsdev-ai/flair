- **Memory and soul feed subscriptions apply the subscriber's read scope.**
  A non-admin agent subscribed to `FeedMemories` receives a memory only when the
  ordinary Memory read rule allows it: its own records at any visibility, plus
  other agents' non-private records. The rule is applied to the full stored row,
  both for the records replayed when the subscription opens and for every live
  change. Delete events are not delivered to a filtered subscriber, since no
  stored row remains to decide from. Verified agents can subscribe to the memory
  feed, and anonymous subscribers are refused. `FeedSouls` already follows the
  Soul read rule (any verified agent reads every soul), and the same tests now
  cover it. Admin and trusted internal subscribers are unchanged.
