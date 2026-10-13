- **`flair doctor`'s audit-log and instance-identity checks route their ops reads to the endpoint verified for the probed instance (#2520).**

  They resolved their ops endpoint independently of the HTTP port doctor probed,
  so they could read from a different instance. Both now use the verified target
  the Agent roster and home checks use: the candidate ops endpoint whose own
  configuration records the probed HTTP port, bound on loopback or on all
  interfaces. Diagnostic reads that run use the verified target; pairing
  refusals report NOT RUN, and existing UNVERIFIED/skipped outcomes remain.
  After a `doctor --fix` step that may have changed the instance (a launchd
  repair, which can also write the admin-pass file, or an install-tree
  restart), the roster and home checks resolve the credential again and, when
  one is available, verify the target with it and use only that answer.
  Configured ports are not proof of the live process.
