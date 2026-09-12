- **Fabric deploys use a disposable npm cache, so hub quota no longer grows with every install.** `flair deploy` and `flair upgrade --target` pass Harper an `install_command` that runs `npm install --cache <tmp>` and deletes that directory after the install, instead of writing tarballs into the node's permanent `~/.npm/_cacache` (flair#886).

  The slope was every install accumulating prebuilds (`node-llama-cpp`, Harper itself) until the hub filled its disk quota. Raising the quota bought time; operators should not need `npm cache clean`.
