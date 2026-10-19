- **Flair turns off Harper's MQTT listeners in component deployments as it does for local installs.**
  `flair deploy` and `flair upgrade --target` send the MQTT-off configuration
  (`set_configuration`: `mqtt.network.port`, `mqtt.network.securePort` and
  `mqtt.webSocket` off) to the target's operations API before deploying,
  replicated with the deploy; if the target refuses it, or names a cluster node
  that did not take it, nothing is deployed. After the deploy's restart they
  read the target's configuration (it must show those values), restart the
  shared worker threads when Flair is an isolated application (Harper's job
  must show every requested node restarted), and check MQTT over WebSocket:
  only a definitive refusal passes, and a check that finds MQTT served or is
  inconclusive fails the deploy with the restart and check to run. Both
  commands take `--ops-target` / `FLAIR_OPS_TARGET` (a URL carrying a
  credential is refused) and `--mqtt-check-url`. `flair doctor` reports an
  instance whose configuration starts an MQTT listener and names the call that
  turns it off.

  > **Heads-up:** to keep an MQTT configuration you turned on deliberately, pass
  > `--keep-mqtt-config` to `flair deploy` / `flair upgrade --target`.
