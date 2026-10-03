- **Soul writes now append a version history and preserve `createdAt` on `PUT`.**
  Accepted `Soul` writes are recorded as chained `InstructionVersion` rows — the
  value digest, the preceding record digest and the stored snapshot — in the same
  transaction as the row write, so a failed append rolls the write back. The
  history is readable by any verified agent; the table has no REST write verb.
