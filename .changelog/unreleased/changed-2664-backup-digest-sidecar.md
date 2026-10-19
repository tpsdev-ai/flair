- **`flair backup` writes a SHA-256 digest beside each archive, and `flair restore` refuses an archive whose digest is missing or does not match.**
  Backup publishes `<archive>.sha256`, the `sha256sum` line for the
  archive's exact bytes, together with the archive. The previous sidecar is
  removed before the archive is replaced and the new one is written after
  it, so a crash never leaves a sidecar beside bytes it does not describe.
  Before any request, in every mode including `--dry-run`, restore reads the
  archive once, hashes and parses that one buffer with the restore-archive
  validator, and compares the hash with the sidecar. The validator also
  refuses a repeated JSON key or row id. The sidecar detects a damaged,
  truncated or mismatched file; it does not prove who wrote the archive
  (flair#2664).

  > **Heads-up:** archives written before this release have no sidecar, and
  > `flair restore` refuses them. Keep each new archive's `.sha256` file with
  > it when you copy or move the archive.
