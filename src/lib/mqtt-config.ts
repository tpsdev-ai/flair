/**
 * mqtt-config.ts — the MQTT-off configuration flair runs Harper with, in the
 * two shapes Harper accepts it, and the reading of an instance's `mqtt`
 * configuration section.
 *
 * Flair does not use MQTT. Harper's mqtt component (server/mqtt.ts
 * `handleApplication`) binds a TCP listener on `mqtt.network.port` (1883) and
 * a TLS listener on `mqtt.network.securePort` (8883) whenever EITHER is truthy
 * (`if (port || securePort)`), plus a WebSocket upgrade path on the HTTP port
 * when `mqtt.webSocket` is true. Nulling only `network.port` leaves
 * `network.securePort` at its 8883 default, so the TLS listener still binds.
 * Fully disabling MQTT requires nulling BOTH ports and turning off the
 * WebSocket path.
 *
 * Where it is applied:
 *   - flair's local spawns: the HARPER_SET_CONFIG builders (src/cli.ts,
 *     src/commands/init.ts) carry MQTT_DISABLED_CONFIG, and the direct-spawn
 *     environment and launchd plist re-assert it with MQTT_* variables;
 *   - a component deployment (`flair deploy`, `flair upgrade --target`):
 *     src/mqtt-off-deploy.ts sends MQTT_DISABLED_SET_CONFIGURATION to the
 *     target's operations API before the deploy, requests the shared worker
 *     threads' restart when the application is isolated, and after the
 *     deploy's restart reads the saved configuration back, which must be a
 *     recognizable root configuration (rootConfigurationProblem) showing
 *     those values (mqttOffConfirmed). It does not probe the listeners. A
 *     component's own config.yaml cannot set it: `mqtt` is a section of the
 *     instance's root configuration, not of an application's.
 * `flair doctor` reports an instance whose saved configuration starts an MQTT
 * listener (src/lib/mqtt-listener-doctor.ts); it reads the configuration, not
 * the running listeners.
 *
 * Note: config-root.schema.json still documents a flat `mqtt.port` /
 * `mqtt.securePort`, but the runtime reads the nested `mqtt.network.*` form
 * (see static/defaultConfig.yaml) — the flat keys are stale.
 */

import { harperPortValue } from "./harper-port-value.js";

/** Harper's `mqtt` configuration section with every MQTT listener off. */
export const MQTT_DISABLED_CONFIG = {
  network: { port: null, securePort: null },
  webSocket: false,
};

/**
 * MQTT_DISABLED_CONFIG as the operations API's `set_configuration`
 * parameters: Harper's flattened config names, each set on its own, so the
 * rest of the instance's `mqtt` section (requireAuthentication, mtls) is left
 * as it is.
 */
export const MQTT_DISABLED_SET_CONFIGURATION: Readonly<Record<string, null | boolean>> = Object.freeze({
  mqtt_network_port: MQTT_DISABLED_CONFIG.network.port,
  mqtt_network_securePort: MQTT_DISABLED_CONFIG.network.securePort,
  mqtt_webSocket: MQTT_DISABLED_CONFIG.webSocket,
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Why `config` is not taken for an instance's root configuration (the
 * operations API's `get_configuration` answer), or null when it is: it must be
 * an object with an object `http`, an object `operationsApi` and a non-empty
 * string `rootPath`, which every root configuration Harper returns carries.
 * It checks only those three fields: an answer missing any of them (`{}`, an
 * error object) is refused, and nothing is concluded from it; any object that
 * carries all three is accepted, whatever else it lacks.
 */
export function rootConfigurationProblem(config: unknown): string | null {
  if (!isObject(config)) return "the answer is not an object";
  const missing = [
    isObject(config.http) ? null : "http",
    isObject(config.operationsApi) ? null : "operationsApi",
    typeof config.rootPath === "string" && config.rootPath !== "" ? null : "rootPath",
  ].filter((m): m is string => m !== null);
  return missing.length ? `it has no ${missing.join(", ")}` : null;
}

/**
 * The MQTT listeners Harper starts for an instance whose root configuration
 * holds `config` (the operations API's `get_configuration` answer), in
 * Harper's own terms: none when the configuration has no `mqtt` section
 * (Harper does not load the component), a WebSocket path when
 * `mqtt.webSocket` is truthy, a TCP listener when `mqtt.network.port` is
 * truthy and a TLS listener when `mqtt.network.securePort` is. Returns a
 * description of each, empty when MQTT is off.
 */
export function mqttListenersOn(config: unknown): string[] {
  const mqtt = isObject(config) ? config.mqtt : undefined;
  if (!isObject(mqtt)) return [];
  const listeners: string[] = [];
  if (mqtt.webSocket) listeners.push("MQTT over WebSocket on the HTTP port (mqtt.webSocket)");
  const network = isObject(mqtt.network) ? mqtt.network : {};
  // A port is printed only as the integer it parses to; any other value is not.
  const portText = (value: unknown) => {
    const port = harperPortValue(value);
    return port === null ? "" : ` ${port}`;
  };
  if (network.port) listeners.push(`MQTT on TCP port${portText(network.port)} (mqtt.network.port)`);
  if (network.securePort) listeners.push(`MQTT on TLS port${portText(network.securePort)} (mqtt.network.securePort)`);
  return listeners;
}

/**
 * Why `config` (a `get_configuration` answer read after the MQTT-off
 * configuration was set) does not show those values, or null when it does:
 * an `mqtt` section whose `network.port` and `network.securePort` are null and
 * whose `webSocket` is false. Unlike mqttListenersOn, an empty or malformed
 * answer is not taken for "off". The reason names fixed field names and
 * categories only ("mqtt.webSocket is not false"), never a value the answer
 * carries.
 */
export function mqttOffConfirmed(config: unknown): string | null {
  if (!isObject(config)) return "the answer is not a configuration object";
  const mqtt = config.mqtt;
  if (!isObject(mqtt)) return "the answer has no mqtt section";
  const problems: string[] = [];
  if (mqtt.webSocket !== false) problems.push(mqtt.webSocket === undefined ? "mqtt.webSocket is missing" : "mqtt.webSocket is not false");
  const network = mqtt.network;
  if (!isObject(network)) {
    problems.push("mqtt.network is missing");
  } else {
    if (network.port !== null) problems.push(network.port === undefined ? "mqtt.network.port is missing" : "mqtt.network.port is not null");
    if (network.securePort !== null) problems.push(network.securePort === undefined ? "mqtt.network.securePort is missing" : "mqtt.network.securePort is not null");
  }
  return problems.length ? problems.join(", ") : null;
}
