- **/mcp tools wrapper-layer test coverage.** Added an integration suite that
  drives every tool in the `TOOLS` registry through its real `.impl` wrapper
  in-process against an ephemeral Harper seeded with realistic data, asserting
  each returns the expected payload shape. Closes the coverage gap behind three
  connector regressions (#1181 unloaded-instance by-id reads, #1188 inlined raw
  embedding vectors, #1182 an un-awaited async spread) that shipped green
  because only the underlying handlers and the signed-REST path were tested,
  never the thin wrapper seam a real /mcp connector drives.
