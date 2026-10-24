- **Harper moves from 5.3.1 to 5.3.3.** The pinned dependency ships its
  production dependencies as a bundle instead of an `npm-shrinkwrap.json`. Those
  copies sit under `node_modules/harper/node_modules` in a bun install too, where
  root overrides do not replace them and `bun audit` reads only `bun.lock`, where they do not appear;
  `node scripts/ci/list-harper-bundled.mjs` prints each copy and its version.

  > **Heads-up:** over MQTT 5, a refused subscription to a protected topic now
  > answers SUBACK `0x87` (Not authorized) instead of `0x80`, from Harper 5.3.3,
  > when Harper admits the session; Harper may refuse the CONNECT first.
