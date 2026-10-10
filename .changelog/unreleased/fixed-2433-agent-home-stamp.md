- **Every path that locally creates an Agent row stamps the creating instance as the new row's home (#2433).**
  Agents created through the operations API — `flair agent add`, `flair init`, `flair
  import`, `flair principal add` and IdP identity mapping — now carry
  `originatorInstanceId` set to the local instance's federation id, the same field the
  Agent resource stamps on a REST create. A request-supplied home is ignored, and the
  home is immutable after create: a write that would change a stored home is refused with
  a named error (`originator_instance_immutable`).

  `flair doctor` reports Agent rows with no home and names the remedy `flair agent
  stamp-home`, which stamps the local id only on rows it can show were created on this
  instance and lists — never stamps — a row that arrived through federation.
