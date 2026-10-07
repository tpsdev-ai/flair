- **An npm-installed bridge plugin is now exercised end to end through the production loader and the real CLI.**
  `flair bridge allow`, `flair bridge import` and `flair bridge export` run against a fixture
  `flair-bridge-*` package installed from a local `file:` dependency, and the fixture's handlers
  record the option record they receive: import's null-prototype record with own option keys only,
  export's plain record, and `Object.hasOwn` on both. (Closes #2308)
