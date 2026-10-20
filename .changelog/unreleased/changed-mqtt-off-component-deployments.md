- **Flair turns off Harper's MQTT listeners in component deployments and restarts the shared workers.**
  `flair deploy` and `flair upgrade --target` send the MQTT-off configuration
  (`set_configuration`: `mqtt.network.port`, `mqtt.network.securePort` and
  `mqtt.webSocket` off) to the target's operations API before deploying,
  replicated with the deploy; if the target refuses it, or names a cluster node
  that did not take it, nothing is deployed. When Flair is an isolated
  application, whose deploy restarts only its own worker, they request the
  shared worker threads' restart (`restart_service`, Harper's pool scope) and
  follow Harper's job, failing on any node it reports without a completed
  restart. After the deploy's restart they read the saved configuration back:
  an answer that is not a recognizable root configuration is reported as not
  confirmed, and a configuration that does not read off fails, named by field
  and category. They report exactly what they set and requested: "MQTT
  listeners configured off on <nodes>; shared workers restart requested (...);
  the saved configuration on <host> reads off. Listeners stop when each node's
  workers restart; flair does not probe them. To confirm on a node, connect an
  MQTT client to its MQTT ports or WebSocket path." Both commands take
  `--ops-target` / `FLAIR_OPS_TARGET`; the target and the operations API URL
  must be http or https URLs with a host and only scheme, host, port and path
  (anything else is refused before anything is printed or sent), and the
  operations API calls follow no redirect. `flair doctor` reports an instance
  whose saved configuration starts an MQTT listener and names the call that
  turns it off; it says, on every path, that it reads the configuration, not
  the running listeners. An answer that is not a recognizable root
  configuration is NOT RUN.

  > **Heads-up:** to keep an MQTT configuration you turned on deliberately, pass
  > `--keep-mqtt-config` to `flair deploy` / `flair upgrade --target`.
