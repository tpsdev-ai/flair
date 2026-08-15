- **`/mcp` `soul_set` now persists instead of erroring.** The tool wrapper did a
  PUT on an unloaded resource instance (`new Cls(undefined, ctx).put(...)`),
  which threw `Invalid primary key type: undefined` against a real store — the
  same #1181 unloaded-instance class already fixed in the other tool wrappers.
  It now writes through a collection-bound `post()` (stamping the required
  `createdAt`), so setting a soul entry over a `/mcp` connector works and is
  readable via `soul_get`. Found by the new wrapper-layer test suite, whose only
  prior `soul_set` coverage exercised a mocked handler.
