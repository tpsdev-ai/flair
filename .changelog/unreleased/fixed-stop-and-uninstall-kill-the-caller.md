- **`flair stop` could kill the process that ran it — and leave Flair running.**
  Its port-based fallback resolved targets with a bare `lsof -ti :<port>`, which
  lists every process holding *any* socket on that port, not just the listening
  server. That includes the caller's own keep-alive client connections, left by
  anything that has spoken HTTP to the instance in the same run — the
  version-handshake nudge that fires on every command, a health probe, a script's
  own `fetch`. `flair stop` then SIGTERM'd the whole list, so it could terminate
  itself before reaching Harper, or take down an unrelated client of the same
  instance. Measured directly against a live instance: `lsof -ti :<port>` returned
  the Harper PID **and** the probing process's own PID; `-sTCP:LISTEN` returned
  the Harper PID alone.

  This is the flair#800 self-SIGTERM, which was fixed in `flair upgrade`'s stop
  step and left in place everywhere else. `flair stop` and `flair uninstall` both
  signalled the unfiltered list; `flair doctor` reported it, so a "port occupied
  by PID N — Fix: kill N" line could name the doctor process the operator was
  watching. All four call sites now go through one guarded helper that filters to
  listening sockets and refuses to return this process's own PID, so the next
  kill-by-port site cannot quietly reintroduce the unsafe form.

  Found while building the flair#905 upgrade-liveness regression suite: the
  suite's teardown called `flair stop`, which killed the test runner mid-teardown
  and discarded every result it had already produced.
