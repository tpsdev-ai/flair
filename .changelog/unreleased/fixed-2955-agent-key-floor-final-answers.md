- **A non-credential server answer to an agent-key fallback attempt is now final, and the fallback refuses redirects.**
  In `src/lib/auth-resolve.ts`, every request the tier-5 fallback sends refuses
  redirects, so a 3xx is that request's final answer. The floor moves to the next
  candidate key file when the Ed25519 authentication middleware refused the
  credential itself (its 401 codes), when an attempt that does not follow
  redirects fails in the connect phase, or when that candidate's key file
  cannot be read or decoded as an Ed25519 key (it is skipped before anything is
  sent). Failures after a key is loaded (nonce, signing) are final. Otherwise
  the answer is final: a failed HTTP response whose body was read is thrown
  with its status and any error code in that body, and a refused redirect is
  thrown with its status before any body is read (#2955).
