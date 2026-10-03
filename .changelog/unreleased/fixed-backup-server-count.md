- **`flair backup` refuses to publish an archive when a collection read returns fewer rows than the server's independent count.** Closes #2228.

  Before publishing, each Agent, Memory and Soul read is checked against a row
  count from the operations API that is not the listing backup reads: an exact
  whole-table `describe_table` count for agents, and a per-agent
  `search_by_value` count for memories and souls. A short read is a hard error
  naming the collection, the agent where the read was per-agent, and both
  counts. A count that cannot be read also refuses publication.
