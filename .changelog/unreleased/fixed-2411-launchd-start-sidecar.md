- **A launchd-managed start records the identity sidecar for the instance it started, once the pid is confirmed.**
  The managed start waits for the instance to answer health, then writes the sidecar the
  direct start path writes, naming the pid launchd reported. When that pid cannot be
  confirmed — launchctl reports none, health does not answer, or the process answering is
  not launchd's — the start writes no sidecar and prints a warning naming the failed check
  (flair#2411).
