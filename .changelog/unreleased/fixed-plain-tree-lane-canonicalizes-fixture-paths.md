- **The plain-tree upgrade CI lane now canonicalizes its fixture paths, so it is truthful on hosts where `TMPDIR` is a symlink.**

  The lane wrote its systemd unit naming a non-canonical scratch path while the product
  canonicalizes a tree before matching units against it (`readFlairPackageAt` →
  `canonicalPath`). Wherever `TMPDIR` or `HOME` sits behind a symlink the two never matched,
  the lane reported `no systemd unit found`, and `release.sh` failed on the macOS release
  host. On Linux runners `/tmp` is a real directory, so fixture path equalled canonical path
  and the lane was green **by accident of the platform's filesystem layout** — not because
  the lane is Linux-only. Measured on one macOS host with nothing but `TMPDIR` changed:
  `/private/tmp` (real) passed, `/tmp` (symlink) failed.

  The fixture now resolves both `home` and its scratch directory with `realpathSync`, so the
  case runs — and passes — on macOS and Linux alike. That is a stronger guarantee than
  skipping it on one platform, which was the first attempt and would have removed coverage
  from the only host where the mismatch reproduces.

  > **Heads-up:** this fixes the *lane*, not the product. A real deploy whose systemd unit
  > names a symlinked path (`/opt/flair -> /srv/flair`) is still never discovered, so
  > `flair upgrade` swaps the tree and silently does not restart the service. Tracked
  > separately.
