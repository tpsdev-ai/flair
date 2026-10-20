- **Flair sets Harper's MQTT listeners off in a component deployment's configuration and requests the shared workers' restart.**
  `flair deploy` and `flair upgrade --target` send the MQTT-off configuration
  (`set_configuration`: `mqtt.network.port`, `mqtt.network.securePort` and
  `mqtt.webSocket` off) to the target's operations API before deploying,
  replicated with the deploy; if the target refuses it, or names a cluster node
  that did not take it, nothing is deployed. When Flair is an isolated
  application (a fresh isolated deploy restarts only its own worker; Harper
  restarts every worker for an application it finds already active), they
  request the shared worker threads' restart (`restart_service`, Harper's pool
  scope; on its own for a standalone instance) and follow Harper's job: a job
  read that does not succeed, a completion message that is not exactly
  Harper's for that job, or a node without a completed restart fails the
  command. After the deploy's restart they read the saved configuration back:
  an answer that is not a recognizable root configuration is reported as not
  confirmed, and a configuration that does not read off fails, named by field
  and category. They report exactly what they set and requested: "MQTT
  listeners configured off on <nodes>; shared workers restart requested (...);
  the saved configuration on <host> reads off. Listeners stop when each node's
  workers restart; flair does not probe them. To confirm on a node, connect an
  MQTT client to its MQTT ports or WebSocket path." `--no-verify` skips the
  restart request and the read-back, on both commands. Both commands take
  `--ops-target` / `FLAIR_OPS_TARGET`; the target and the operations API URL
  must be http or https URLs with a host and only scheme, host, port and path
  (anything else is refused before anything is printed or sent), and the
  operations API calls follow no redirect. `flair doctor` reports an instance
  whose saved configuration starts an MQTT listener and names the operation
  that sets it off in the configuration (Flair's default); it says, on every
  path, that it reads the configuration, not the running listeners. An answer
  that is not a recognizable root configuration is NOT RUN.

  > **Heads-up:** to keep an MQTT configuration you turned on deliberately, pass
  > `--keep-mqtt-config` to `flair deploy` / `flair upgrade --target`.
