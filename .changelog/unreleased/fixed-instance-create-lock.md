- **Concurrent first-boot `GET /FederationInstance` requests share one identity row; callers unable to acquire the creation lock receive a refusal.**

  The read, identity creation and confirming re-read run under a filesystem
  bakery lock at `<rootPath>/flair-locks/instance-create/`, shared by HTTP
  workers and processes using that store root. The handler returns the
  confirmed row.

  Lock-directory and acquisition-deadline refusals return `503`; the default
  deadline is 10 seconds and the refusal names a blocking claim when known.
  A confirming re-read that finds no row also returns `503`; multiple rows
  return `409`.

  An unusable signing-key store does not itself prevent identity-row creation.
  The `flair init --remote` writer does not participate in this lock.

  (Refs #1897)
