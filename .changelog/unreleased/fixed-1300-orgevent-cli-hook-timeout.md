- The orgevent CLI unit suite no longer dice-rolls a hook timeout under CI
  runner load (#1300). Its `beforeAll` execSyncs a full CLI build, which has
  exceeded bun's default 5s hook budget on a PR that never touched the file
  (observed 5005ms on #1299's run); the hook now carries an explicit 120s
  timeout. Test-lane hygiene only — no runtime behavior changes.
