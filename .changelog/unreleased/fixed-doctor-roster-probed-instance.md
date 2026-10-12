- **`flair doctor` reads its Agent roster and home checks only from an ops endpoint whose own configuration names the HTTP port it probed.**

  It picks the candidate ops endpoint with the port-pair rule `flair agent
  stamp-home` uses, then asks that endpoint for its configuration, the check
  `agent remove` and `memory hygiene --apply` use. The configuration must record
  that ops port, and the HTTP port doctor probed, bound on loopback or on all
  interfaces. No Instance row is needed, so a fresh install runs both checks.
  Both checks are reported as not run and counted as an issue, with the reason
  and a remedy, and no Agent row is read, when the port check fails (the
  port-pair rule or the configuration check refuses or cannot complete), or when
  both endpoints report one Instance id each and the ids differ. Configured ports
  are not proof of the live process: the configuration read reports the ports
  the instance's configuration records.
