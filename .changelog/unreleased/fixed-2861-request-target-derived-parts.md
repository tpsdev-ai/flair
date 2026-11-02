- **Requests reaching TPS-Ed25519 authentication whose raw targets WHATWG URL parsing would rewrite receive `400 non_canonical_request_target` (#2861).**
  The signature is verified over the target exactly as received. The candidate listing refuses a target whose parsed query would differ before reading that query.
