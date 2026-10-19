- **`flair backup-approval` lets the operator approve backup archives on the restoring host, including archives written before digest sidecars.**
  Approvals live in `~/.flair/approved-archives/`: directories mode 0700
  and files 0600, owned by the operator, with anything else refused. The
  store keeps a copy of each approved archive under its SHA-256 and a record
  of the approval time and operator. No REST route can approve, revoke, list
  or read it. `approve` verifies an archive against its `.sha256` sidecar.
  `legacy-admit` prints a sidecar-free archive's SHA-256 and approves it only
  when the operator repeats that digest with `--confirm-digest`. `list`
  checks each stored copy, and `revoke` withdraws an approval. Approving and
  revoking need operator credentials, checked as a super_user against this
  host's operations API. `flair restore` admits an archive with no sidecar
  only when this host holds an unrevoked approval for its digest whose stored
  copy still hashes to it, and restores that stored copy; a sidecar-backed
  archive needs no approval. An approval authorizes those bytes until it is
  revoked. It does not show where they came from or that a sidecar-free
  archive is unchanged since it was written (flair#2664).

  > **Heads-up:** to restore a backup written before this release, first run
  > `flair backup-approval legacy-admit <archive>` on the restoring host,
  > check the SHA-256 it prints, then run it again with
  > `--confirm-digest <sha256>`.
