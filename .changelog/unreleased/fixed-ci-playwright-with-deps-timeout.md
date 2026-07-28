- **CI: the Integration Tests lane no longer depends on the Ubuntu apt mirror to
  run browser tests.** `playwright install` was being invoked with
  `--with-deps`, which on `ubuntu-latest` installed nothing Chromium needs — every
  required library is already on the image — and instead pulled 21.1 MB of
  CJK/Thai/Cyrillic and X11 bitmap font packages the E2E suite never renders. When
  that mirror degraded on 2026-07-28 the step stalled past the job's 20-minute
  timeout and discarded integration and E2E CLI results that had already passed,
  reporting `cancelled` rather than `failure`. The flag is gone, Playwright's
  browser downloads are now cached on the resolved Playwright version, and the
  job's timeout has headroom. No effect on shipped code.
