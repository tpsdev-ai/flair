- **The dependency audit gate accepts harper's bundled dependencies as vendor evidence.**
  Releases without `npm-shrinkwrap.json` are verified through the consumer install's
  package-lock (`inBundle`) and harper's `bundleDependencies`, and every other node
  still blocks.
