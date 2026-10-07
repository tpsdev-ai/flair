- **`flair keys prune` checks the source sidecar path's type before moving it and the archive path's type after the move.**
  Non-regular sidecars found by these checks leave the key active.
  These checks do not establish object identity. Before the key moves, the source path can change after its pre-move/absence check and the archive path can change between move and check or after the check.
