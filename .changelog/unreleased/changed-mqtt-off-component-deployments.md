- **Flair turns off Harper's MQTT listeners in component deployments as it does for local installs.**
  `flair deploy` and `flair upgrade --target` send the MQTT-off configuration
  (`set_configuration`: `mqtt.network.port`, `mqtt.network.securePort` and
  `mqtt.webSocket` off) to the target's operations API before deploying,
  replicated with the deploy; if the target refuses it, or names a cluster node
  that did not take it, nothing is deployed. After the deploy's restart they
  verify the node the target URL reaches: its configuration must show those
  values, the shared worker threads are restarted when Flair is an isolated
  application (a failure Harper's job reports fails the deploy), and an
  MQTT-over-WebSocket check authenticated with the deploy's credential must get
  Harper's own answer for a disabled path; a check that finds MQTT served or is
  inconclusive fails the deploy with the restart and check to run. Every other
  cluster node is reported NOT VERIFIED with the check to run on it — a
  completed restart job is not proof of a peer's restart — and
  `--require-all-nodes-verified` turns that into a failure. Both commands take
  `--ops-target` / `FLAIR_OPS_TARGET` and `--mqtt-check-url`; the target and
  those URLs must be scheme, host, port and path only (a user name, password,
  query or fragment is refused before anything is printed or sent). `flair
  doctor` reports an instance whose configuration starts an MQTT listener and
  names the call that turns it off; an answer that is not a recognizable root
  configuration is NOT RUN.

  > **Heads-up:** to keep an MQTT configuration you turned on deliberately, pass
  > `--keep-mqtt-config` to `flair deploy` / `flair upgrade --target`.
