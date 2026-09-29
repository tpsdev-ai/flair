- **The Hermes plugin's key loader now accepts a base64-encoded raw 32-byte Ed25519 seed**
  in addition to raw seeds, PEM keys, and base64-encoded PKCS8 DER, mirroring 
  `src/lib/auth-resolve.ts` and `packages/adk-flair-js/src/signing.ts`.
