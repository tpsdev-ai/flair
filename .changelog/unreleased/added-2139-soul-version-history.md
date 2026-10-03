- **Soul resource writes now append version history and preserve `createdAt` on `PUT`.**
  Accepted `Soul` resource writes record chained `InstructionVersion` rows in the
  row write transaction. `InstructionVersion` REST mutation verbs are refused; verified agents can read
  the history. The administrator operations API is an unaudited exception.
