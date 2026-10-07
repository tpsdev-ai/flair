- **`flair keys prune` checks ownership sidecars before and after moving them.**
  Non-regular sidecars found by these checks leave the key active.
  The source path can change after its pre-move/absence check and the archive path after verification, before the key moves.
