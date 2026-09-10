- **Flair now fully disables Harper's MQTT broker.** The previous config nulled
  only `mqtt.network.port`, leaving the TLS listener on `mqtt.network.securePort`
  (8883) still bound — and the direct-spawn path (`flair restart` / `flair
  upgrade`) re-enabled MQTT entirely. Flair does not use MQTT, so both the TCP
  (1883) and TLS (8883) listeners are now turned off on every spawn path,
  including test-spawned Harpers.
