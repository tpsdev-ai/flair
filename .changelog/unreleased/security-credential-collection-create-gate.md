- **Creating a `Credential` is now gated and attributed to the authenticated principal.** The
  resource declared a read gate and a cross-principal check on update, but no gate on creation — so
  a `POST` to the collection reached the base implementation with no cross-principal check, and
  `principalId` was taken from the request body.

  Creation now requires a verified principal, and `principalId` is stamped from the authenticated
  identity rather than trusted from the body. A non-admin agent can only create credentials
  attributed to itself.

  **Upgrading is recommended.** The gap was in creation only; existing credentials were never
  readable across principals.
