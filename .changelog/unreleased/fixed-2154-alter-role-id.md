- **The CLI's role update sends the role's `id`, so `ensureFlairAgentRole` and
  `ensureFlairPairInitiatorRole` can change an existing role on Harper 5.2.8.**
  Harper's `alter_role` addresses a role by that `id` and refuses a call without
  it ("Id can't be blank"). In the previous release the call omitted it, so
  bringing an existing role's permissions to the expected spec failed and the
  role kept its old permissions.

  (Closes #2154)
