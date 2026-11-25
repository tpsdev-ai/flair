- **`flair init` against a remote cluster now authenticates its later calls as the principal provisioning selected.**

  When `list_users` shows the cluster administrator is a super_user, the run
  reuses that administrator with the password the operator supplied; otherwise
  it creates (or updates) `admin` with the chosen Flair admin password. The
  flair_agent role and shared agent user (plus the pair-initiator role and the
  federation-instance reconcile with `--remote`), the Agent seed when
  `--agent-id` is given, the skill seed and the verification read all
  authenticate as that principal. The
  summary names the password the principal actually has: the chosen Flair
  admin password written to the admin-pass file, or the cluster administrator
  password the run supplied. Previously the reusing branch still authenticated
  as `admin` with the Flair admin password, which that run had not set on the
  instance.

  The admin-pass file is written after provisioning and only when provisioning
  created or updated `admin`; when provisioning reuses an existing
  administrator, init does not write the admin-pass file and leaves an existing
  one unchanged. The reserved shared agent account (`flair-agent`) is refused as
  either leg's administrator input (a cluster administrator or `--admin-user`)
  before any write.
