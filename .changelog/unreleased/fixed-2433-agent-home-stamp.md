- **Every path that locally creates an Agent row stamps the creating instance as the new row's home (#2433).**
  Agents created through the operations API — `flair agent add`, `flair init`, `flair
  import`, `flair principal add` and IdP identity mapping — now carry
  `originatorInstanceId` set to the local instance's federation id, the same field the
  Agent resource stamps on a REST create. A request-supplied home is ignored, and a
  stored home cannot be changed by a later write.

  `flair doctor` lists Agent rows with no home. On an instance with one Instance row it
  prints an advisory (not counted as an issue) naming the remedy `flair agent
  stamp-home`, which stamps the local id only on rows it can show were created on this
  instance and lists — never stamps — a row that arrived through federation. On an
  instance with no Instance row, or with several, it prints an info line (not counted):
  homes stay unset, the local-origin state, until the instance has one identity.
