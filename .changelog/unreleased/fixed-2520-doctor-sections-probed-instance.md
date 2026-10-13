- **`flair doctor`'s audit-log and instance-identity checks read the probed instance, report NOT RUN, or stay UNVERIFIED without an admin credential (#2520).**

  They resolved their ops endpoint independently of the HTTP port doctor probed,
  so they could read from a different instance. Both now use the verified target
  the Agent roster and home checks use: the candidate ops endpoint whose own
  configuration records the probed HTTP port, bound on loopback or on all
  interfaces. When that pair check refuses, all four sections report NOT RUN and
  count as an issue, and the four diagnostic section reads do not run. With no
  admin credential there is no target to check, and each section keeps its
  UNVERIFIED or skipped state. The credential and the check describe the
  instance when they ran, so after a `doctor --fix` step that may have changed
  it (a launchd repair, which can also write the admin-pass file, or an
  install-tree restart), the roster and home checks resolve the credential and
  run the check again, and use only that answer. Configured ports are not proof
  of the live process.
