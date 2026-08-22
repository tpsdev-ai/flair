- pi-flair: declare pi's package manifest (`"pi": {"extensions": ["./dist/index.js"]}`)
  in package.json — pi resolves npm-installed packages only through the `pi` manifest
  key or convention directories, never `main`, so `pi install npm:@tpsdev-ai/pi-flair`
  installed the package but silently registered zero tools; only loading `dist/index.js`
  by file path worked (#1346)
