- **`flair upgrade` can upgrade a plain extracted package tree in place.** Hosts
  that run `npm pack` + `npm install --omit=dev` under systemd (no git checkout,
  no npm-global install) now have a lane: fetch the published tarball, swap the
  tree, keep operator launchers that are not in the pack, and restart the
  systemd unit that points at the tree. `flair upgrade --tree <dir>` selects
  the tree explicitly; `--flair-version` pins the tarball. The npm-global and
  Fabric `--target` lanes are unchanged. (flair#1109)
