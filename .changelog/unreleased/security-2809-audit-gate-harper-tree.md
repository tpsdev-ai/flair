- **The dependency audit gate checks the directories leading to a vendor-pinned node under harper, and walks harper's bundle with Node's search paths.**
  A vendor-pinned node under harper blocks when its package directory, or a
  directory between harper's directory and it, resolves outside harper's installed
  tree. When harper ships no `npm-shrinkwrap.json`, the walk through a bundled
  package's dependency closure looks a dependency up in the `node_modules`
  directories Node's resolver searches from the requiring package's directory,
  stopping at harper's directory, and blocks when a package it resolves, or a
  directory on the way to it, resolves outside harper's installed tree.
