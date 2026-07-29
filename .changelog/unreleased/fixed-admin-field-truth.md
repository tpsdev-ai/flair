- **The `admin` field on a principal now means what it says.** A principal record
  carried two fields that both read as "is this an administrator" — `role`
  (admin when the value is `admin`) and an `admin` boolean — and they were
  consulted by different parts of the system. The authorization gate read
  `role`; the CLI, the admin dashboard and every creation path used `admin`. So
  `flair principal add --admin` stored a field the gate never read and granted
  nothing, while `flair principal show` reported "admin: yes" for a principal
  that admin-only endpoints reject.

  `role` remains the authority and no existing principal's rights change. The
  boolean is now a server-maintained mirror of it: write either one through the
  `Agent` resource, `flair principal add --admin`, or agent seeding, and both
  are set together, so a record can no longer be stored saying one thing in one
  field and the opposite in the other. Every surface that decides or displays
  admin status now resolves through one shared predicate.

  Records written straight to the table (an ops-API insert, a federation merge)
  bypass that reconciliation and can still carry a mismatch. Nothing changes
  about what they are allowed to do — `flair principal show`, `flair principal
  list` and the admin dashboard now flag them as inconsistent instead of
  silently picking a side. Re-issuing the grant repairs the record.
