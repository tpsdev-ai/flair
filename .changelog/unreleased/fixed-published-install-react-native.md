- **Published `npm i @tpsdev-ai/flair` no longer pulls React Native.** Harper still ships, and the platform RocksDB binding still installs; `react-native-fs` is an optional peer on the AlaSQL copy consumers receive, which npm does not auto-install (flair#847).

  Repo-root `overrides` only apply when Flair is the install root — this repo and `npm i -g` — so they never reached a clean-directory install. The published tarball now depends on a pack-time Harper that bundles that patched AlaSQL. A CI gate installs the packed tarball as a *dependency* under npm 12 (the resolver that still pulled the 160 MB / 136-package React Native subtree) and requires `node_modules/react-native` to be absent.

  > **Heads-up:** do not install with `--omit=optional` to skip React Native. That flag also drops Harper's RocksDB platform bindings.
