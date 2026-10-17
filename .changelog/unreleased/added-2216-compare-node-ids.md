- **Compare the Memory ids of explicitly named nodes.** `flair memory compare-nodes --node <ops-url>`
  (twice or more) compares observed Memory ids and stored timestamps through the same operations-API
  read the memory checkpoint uses and classifies each node in-sync, lagging, divergent or unknown;
  the overall result is healthy only when every node is in-sync, and any unknown makes it unknown,
  never healthy. Timestamps use parseable `updatedAt`, else possibly caller-supplied `createdAt`;
  node clocks can differ, so these do not establish write order. `--json` prints the per-node result;
  exit codes are 0 healthy, 2 divergent, 3 unknown and 4 lagging (flair#2216).
