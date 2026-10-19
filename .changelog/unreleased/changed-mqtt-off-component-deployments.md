- **Flair turns off Harper's MQTT listeners in component deployments, and verifies it on the node at the operations API URL's host.**
  `flair deploy` and `flair upgrade --target` send the MQTT-off configuration
  (`set_configuration`: `mqtt.network.port`, `mqtt.network.securePort` and
  `mqtt.webSocket` off) to the target's operations API before deploying,
  replicated with the deploy; if the target refuses it, or names a cluster node
  that did not take it, nothing is deployed. After the deploy's restart they
  verify the node at the operations API URL's host: its configuration must show
  those values, the shared worker threads are restarted when Flair is an
  isolated application (a failure Harper's job reports fails the deploy), and
  an MQTT-over-WebSocket check authenticated with the deploy's credential, sent
  to that host on the HTTP port its configuration names, must get Harper's own
  answer for a disabled path; a check that finds MQTT served or is inconclusive
  fails the deploy with the restart and check to run. What is verified is that
  node: the configuration read from its operations API plus the WebSocket check
  sent to that host (a host name that load-balances across nodes is not
  separated). `--mqtt-check-url` confirms the check's address and can choose
  its scheme; it is refused unless it names that host and one of its configured
  HTTP ports. Every other cluster node is reported NOT VERIFIED with the live
  check to run on it — a completed restart job is not proof of a peer's
  restart — and `--require-all-nodes-verified` turns that into a failure; it is
  refused, before anything is deployed, with `--no-verify`, `--no-restart`,
  `--keep-mqtt-config` or `--verify-mqtt-only`. New: `flair deploy
  --verify-mqtt-only --ops-target <node>` runs that check for one node without
  deploying, setting or restarting anything, and exits 0 only when both show
  MQTT off. The target and operations API URL must be http or https and the
  check URL http, https, ws or wss, each with a host and only scheme, host,
  port and path (anything else is refused before anything is printed or sent);
  a redirect from the operations API is not followed. A configuration mismatch
  is reported by field name and category, never the value. `flair doctor`
  reports an instance whose saved configuration starts an MQTT listener and
  names the call that turns it off; it says it reads the configuration, not the
  running listeners, and names `--verify-mqtt-only` for a live check. An answer
  that is not a recognizable root configuration is NOT RUN.

  > **Heads-up:** to keep an MQTT configuration you turned on deliberately, pass
  > `--keep-mqtt-config` to `flair deploy` / `flair upgrade --target`.
