- Regression tests pinning two mechanisms from the #1284 review (#1285): a
  boot-level test for the `FLAIR_MCP_OAUTH` vocabulary asymmetry (`1` yields a
  guarded `/mcp` with NO authorization server mounted — the broken-on state a
  regression re-staging `'1'` in the secrets bundle would ship), and a deploy
  re-pack test codifying that an operator edit to a deployed component
  `config.yaml` does not survive a re-packed deploy (the payload derives
  strictly from the package root's published file set).
