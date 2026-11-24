- **`flair init` against a remote cluster now authenticates its later calls as the principal provisioning selected.**

  When `list_users` shows the cluster administrator is a super_user, the run
  reuses that administrator with the password the operator supplied; otherwise
  it creates (or updates) `admin` with the chosen Flair admin password. The
  pair-initiator and agent roles, the shared agent user, the Agent and skill
  seeds and the verification read all authenticate as that principal. The
  summary names the password the principal actually has: the chosen Flair
  admin password written to the admin-pass file, or the cluster administrator
  password the run supplied. Previously the reusing branch still authenticated
  as `admin` with the Flair admin password, which that run had not set on the
  instance.
