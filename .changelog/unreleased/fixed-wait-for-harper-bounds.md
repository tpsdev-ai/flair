- **The Harper start waiter rejects a `NODE_` credentials name, a per-request cap above `2147483647` ms, and a credentialed health URL from a direct `main` caller.**
  Once the waiter starts, each refusal exits with status 2 before any Docker or HTTP work; Node reads `NODE_OPTIONS` itself before the waiter starts.
