- **The managed-start confirmation probe reads only the response the port it probed returned (#2485).**

  A port that passed the reachability wait and then answered the probe with a
  redirect was reported as running Flair when the redirect target was a Flair
  instance. The probe sends `redirect: "manual"`, so a redirect from the probed
  port is reported as a response that is not a Flair health answer.

  When `flair doctor --fix` adopts a directly started instance into launchd,
  the probe that waits for the stopped instance's port to free also sends
  `redirect: "manual"`, so a redirect from that port is likewise reported as a
  response that is not a Flair health answer.
