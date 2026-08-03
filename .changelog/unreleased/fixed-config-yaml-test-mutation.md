- **A crashed test run no longer leaves `config.yaml` permanently modified.**
  `mcp-client-credentials-e2e` wrote the OAuth component block into the repository's real
  `config.yaml` and restored it in `afterAll`. A kill or crash mid-run left the block in place,
  and the next real instance start would silently 404 on `/.well-known/oauth-authorization-server`
  — the OAuth surface was absent with no error, because `@harperfast/oauth` is not a declared
  dependency in the shipped config. The test now stages the block into a temp copy and points
  Harper at it; the real `config.yaml` is never touched.
