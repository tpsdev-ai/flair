- **The dependency audit gate accepts harper's bundled dependencies as vendor evidence.**
  Releases without `npm-shrinkwrap.json` are verified through the consumer install's
  package-lock (`inBundle`) and harper's `bundleDependencies`. On such a release a
  vendor-pinned node under harper blocks when the package-lock does not mark it
  `inBundle`, or when its top-level package under harper is neither a bundled package
  nor in a bundled package's dependency closure. On every release, a vendor-pinned
  node under harper whose package.json resolves outside harper's installed tree blocks.
