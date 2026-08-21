- `GET /FederationInstance` no longer 500s with "Keystore unavailable" when the
  server's HOME-relative keystore is unwritable (the Fabric-managed hub shape) —
  reads never require identity-creation capability (#1233). The identity row is
  still created; a keystore write failure is logged server-side with the real
  remedy and surfaced as a runtime-only `signingKeyAvailable: false` field on
  the GET response. `flair federation status` now fetches instance and peers
  independently — one failing read marks that section unverifiable instead of
  aborting the whole render — and shows a degraded marker (keystore path +
  permission fix) when the signing key is unavailable. Signing (pair/sync)
  remains fail-closed; `loadInstanceSecretKey`'s error text names the real
  recovery instead of the impossible "re-run flair federation status to
  regenerate" advice.
