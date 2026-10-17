- **Agent and admin OrgEvent resource writes assign createdAt on create and preserve it on update (#2551).** An observed change returns 409 created_at_immutable without writing.

  > **Heads-up:** Omit createdAt when updating an existing event.
