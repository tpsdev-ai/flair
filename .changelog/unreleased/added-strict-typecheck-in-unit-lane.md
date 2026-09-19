- **`bun run test:unit` now type-checks the tree before it runs tests.**

  The unit lane runs the same four strict `tsc` configs as CI's "Type Check
  (strict)" job, in the same order, ahead of the test steps. bun's test
  transpiler strips types rather than checking them, so without this the lane
  could report a green result on a tree that does not compile.
