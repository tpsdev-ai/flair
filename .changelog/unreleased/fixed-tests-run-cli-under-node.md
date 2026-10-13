- **Tests that start a local Harper now run the flair CLI under node, the runtime every shipped path uses (#2570).**

  A test that spawned the built CLI with the test runner's Bun
  (`spawn(process.execPath, [cliPath, "init", ...])`) made `flair init` start
  Harper under Bun, which exercises a different module loader than the shipped
  one and can raise `ResourceLoadError` at component load. Tests that drive the
  shipped CLI now spawn it through a shared `nodeBin()` helper, and a guard test
  fails when a test spawns the shipped CLI with an instance-starting subcommand,
  or a Harper binary, under Bun.
