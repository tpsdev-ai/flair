- **Agent and admin OrgEvent resource writes use server time when no stored row is observed and preserve observed stored createdAt (#2551).** An observed change returns 409 created_at_immutable without writing.

  > **Heads-up:** Omit createdAt when updating an existing event.
