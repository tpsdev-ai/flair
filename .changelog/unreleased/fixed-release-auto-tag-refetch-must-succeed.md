- **The release tagger refuses to tag from a stale `main`.** The second fetch of
  `main` in the tag job — taken after the re-derivation's up-to-30-minute wait —
  now has an id, and the tag step's condition requires that fetch to have
  succeeded. Under `always()` alone, a failed fetch left `origin/main` at its
  older value while the tag step still ran, so condition 10 could tag the release
  that had been superseded during the wait. The fetch runs regardless of the App
  token mint, so the separate path that reports a failed mint as
  `app-not-configured` is unchanged.
