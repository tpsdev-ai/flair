- **`flair doctor`'s audit-log and instance-identity checks read the probed instance, or report NOT RUN (#2520).**

  They resolved their ops endpoint independently of the HTTP port doctor probed,
  so they could read from a different instance. Both now use the verified target
  the Agent roster and home checks already use: the candidate ops endpoint whose
  own configuration records the probed HTTP port, bound on loopback or on all
  interfaces. When that pair check refuses, all four sections report NOT RUN and
  count as an issue, and no endpoint is read. Configured ports are not proof of
  the live process.
