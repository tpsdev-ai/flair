- **Non-admin writes to protected owner-scoped resources verify the addressed record and stored owner (#2551).** Writes refused by this guard leave the target row unchanged.

  > **Heads-up:** Non-admin PUT, PATCH and DELETE must address one record.
