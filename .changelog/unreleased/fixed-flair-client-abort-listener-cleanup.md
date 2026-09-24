- **The combined abort signal removes both listeners as soon as either input aborts.**

  `anySignal`'s hand-linked fallback (the Node < 20.3 path) now removes the
  listener it holds on EACH input the moment either signal aborts, and the
  client runs the returned cleanup in a `finally` that wraps the whole request
  lifecycle — so a caller's long-lived signal cannot accumulate a listener
  across requests, on success, timeout, a response error or a JSON error.

  (Refs #1751)
