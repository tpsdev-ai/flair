- **Single-row Soul resource writes append history; Soul collection deletes are refused.**
  `PUT` preserves `createdAt`. `InstructionVersion` REST writes are refused;
  verified agents can read Soul history. The administrator operations API is an unaudited exception.
