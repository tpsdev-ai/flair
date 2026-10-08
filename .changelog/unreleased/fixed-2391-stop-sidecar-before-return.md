- **`flair stop` no longer returns with the identity sidecar still naming the pid it stopped.**
  Once the stop has confirmed the daemon exited, the sidecar naming that pid is
  removed as part of the stop, before it reports success. The stop no longer
  reads that pid's liveness a second time: a re-read can land after the child is
  reaped and report the pid alive, which previously skipped the removal and left
  a later instance under another supervisor refusing with "its identity could not
  be verified" (flair#2391).
