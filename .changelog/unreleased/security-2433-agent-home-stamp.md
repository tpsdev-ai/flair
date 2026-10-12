- **Flair-managed local Agent creation records the home when one canonical Instance row resolves (#2433).**
  Agents created through the operations API — `flair agent add`, `flair init`, `flair
  import`, `flair principal add` and IdP identity mapping — now carry
  `originatorInstanceId` set to the local instance's federation id when one canonical
  Instance row resolves, as on a REST create. A request-supplied home is ignored, and
  the Agent resource and `flair principal add` do not change a stored home.

  `flair doctor` lists Agent rows with no home. On an instance with one Instance row it
  prints an advisory (not counted as an issue) naming the dry-run remedy `flair agent
  stamp-home`; `flair agent stamp-home --apply` stamps the local id on home-less rows
  that carry no federation-sync provenance and lists rows with that provenance without
  stamping them. On an instance with no Instance row, or with several,
  it prints an info line (not counted):
  homes stay unset, the local-origin state, until the instance has one identity.
  `flair doctor` now counts an unreadable agent roster as an issue, and reports the Agent
  homes check as skipped, not counted, when no admin credential is available. The Agent
  resource keeps the stored federation bookkeeping fields (`_syncedFrom`,
  `_originatorInstanceId`) on update and drops them from a create.
