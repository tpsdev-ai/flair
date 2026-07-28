- **Fixed: the in-process by-id scoping test picked its target by a coin flip.** It selected "the first
  private record" from a `search_by_value` on the non-unique `agentId` index. Measured: that operation
  returns rows in **primary-key order**, and Harper mints `Memory.id` as a random UUID — so once an
  agent owned more than one private record, which one came back was re-decided on every run. It passed
  locally and failed in CI on the owner *control*, meaning the cross-agent assertion it exists for
  never executed in that run. An order-dependent security proof is not a proof. The test now names its
  target explicitly (the id returned by the write), verifies against storage that the record really is
  private and owned by the other agent, and then asserts the denial across **every** private record
  that agent owns rather than one lucky pick.
