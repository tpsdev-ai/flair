- **The HTTP bind hardening also covers TLS listeners, reverses a widening, and closes the spawn environment.**

  An enabled TLS listener's host is now qualified the same way as the plaintext
  bind, because a bare secure port binds all interfaces too. `flair init
  --http-bind 127.0.0.1` now narrows a previously widened install back, and the
  direct-spawn paths (`start` fallback, `restart`, `upgrade`) no longer pass an
  inherited `HARPER_SET_CONFIG` through to Harper.
