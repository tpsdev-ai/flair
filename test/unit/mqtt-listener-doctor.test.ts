/**
 * mqtt-listener-doctor.test.ts — the `flair doctor` MQTT listener check
 * (src/lib/mqtt-listener-doctor.ts) and the reading of an instance's `mqtt`
 * configuration section it rests on (src/lib/mqtt-config.ts).
 *
 * The check decides from the instance's root configuration, in Harper's own
 * terms (server/mqtt.ts `handleApplication`): a WebSocket path when
 * `mqtt.webSocket` is truthy, a TCP listener when `mqtt.network.port` is, a TLS
 * listener when `mqtt.network.securePort` is, and nothing when there is no
 * `mqtt` section. test/integration/mqtt-off-deploy-doctor.test.ts runs it
 * through the real CLI against a real Harper.
 */
import { describe, expect, test } from "bun:test";
import { MQTT_DISABLED_CONFIG, mqttListenersOn } from "../../src/lib/mqtt-config.ts";
import { MQTT_LISTENERS_OFF_LINE, describeMqttListenerFinding, readInstanceConfiguration } from "../../src/lib/mqtt-listener-doctor.ts";

/** Harper's shipped defaults (static/defaultConfig.yaml). */
const HARPER_DEFAULTS = { network: { port: 1883, securePort: 8883, mtls: false }, webSocket: true, requireAuthentication: true };

describe("mqttListenersOn", () => {
  test("Harper's defaults start all three listeners", () => {
    expect(mqttListenersOn({ mqtt: HARPER_DEFAULTS })).toEqual([
      "MQTT over WebSocket on the HTTP port (mqtt.webSocket)",
      "MQTT on TCP port 1883 (mqtt.network.port)",
      "MQTT on TLS port 8883 (mqtt.network.securePort)",
    ]);
  });

  test("flair's MQTT-off configuration starts none, whatever else the section holds", () => {
    expect(mqttListenersOn({ mqtt: MQTT_DISABLED_CONFIG })).toEqual([]);
    expect(mqttListenersOn({ mqtt: { ...MQTT_DISABLED_CONFIG, network: { ...MQTT_DISABLED_CONFIG.network, mtls: false }, requireAuthentication: true } })).toEqual([]);
  });

  test("each listener is reported on its own: a null TCP port leaves the TLS listener on", () => {
    expect(mqttListenersOn({ mqtt: { network: { port: null, securePort: 8883 }, webSocket: false } })).toEqual(["MQTT on TLS port 8883 (mqtt.network.securePort)"]);
    expect(mqttListenersOn({ mqtt: { network: { port: 1883, securePort: null }, webSocket: false } })).toEqual(["MQTT on TCP port 1883 (mqtt.network.port)"]);
    expect(mqttListenersOn({ mqtt: { network: { port: null, securePort: null }, webSocket: true } })).toEqual(["MQTT over WebSocket on the HTTP port (mqtt.webSocket)"]);
  });

  test("a truthy webSocket value that is not `true` (WebSocket options) is on, as Harper reads it", () => {
    expect(mqttListenersOn({ mqtt: { webSocket: { maxPayload: 1024 } } })).toEqual(["MQTT over WebSocket on the HTTP port (mqtt.webSocket)"]);
  });

  test("no mqtt section (Harper does not load the component) and malformed input start none", () => {
    expect(mqttListenersOn({})).toEqual([]);
    expect(mqttListenersOn({ mqtt: null })).toEqual([]);
    expect(mqttListenersOn(null)).toEqual([]);
    expect(mqttListenersOn("mqtt")).toEqual([]);
  });
});

describe("describeMqttListenerFinding", () => {
  test("passes an instance with MQTT off", () => {
    expect(describeMqttListenerFinding({ mqtt: MQTT_DISABLED_CONFIG })).toBeNull();
    expect(MQTT_LISTENERS_OFF_LINE).toContain("No MQTT listener is configured");
  });

  test("names every listener that is on and the set_configuration call that turns them off", () => {
    const finding = describeMqttListenerFinding({ mqtt: HARPER_DEFAULTS })!;
    expect(finding.message).toContain("3 MQTT listeners");
    expect(finding.message).toContain("MQTT on TCP port 1883");
    expect(finding.message).toContain("MQTT on TLS port 8883");
    expect(finding.message).toContain("MQTT over WebSocket on the HTTP port");
    expect(finding.fixHint).toContain(JSON.stringify({
      operation: "set_configuration",
      mqtt_network_port: null,
      mqtt_network_securePort: null,
      mqtt_webSocket: false,
    }));
    expect(finding.fixHint).toContain("restart");
  });

  test("one listener reads as one", () => {
    expect(describeMqttListenerFinding({ mqtt: { webSocket: true } })!.message).toContain("starts an MQTT listener:");
  });
});

describe("readInstanceConfiguration", () => {
  const args = (fetchImpl: any) => ({ opsUrl: "http://127.0.0.1:1/", authHeader: "Basic x", fetchImpl, timeoutMs: 1000 });

  test("returns the configuration object get_configuration answers with", async () => {
    let sent: any;
    const config = await readInstanceConfiguration(args(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ mqtt: HARPER_DEFAULTS });
    }));
    expect(sent).toEqual({ operation: "get_configuration" });
    expect(config).toEqual({ mqtt: HARPER_DEFAULTS });
  });

  test("a failed read is null, never an empty configuration", async () => {
    expect(await readInstanceConfiguration(args(async () => new Response("no", { status: 401 })))).toBeNull();
    expect(await readInstanceConfiguration(args(async () => Response.json([1, 2])))).toBeNull();
    expect(await readInstanceConfiguration(args(async () => new Response("not json", { status: 200 })))).toBeNull();
    expect(await readInstanceConfiguration(args(async () => { throw new Error("ECONNREFUSED"); }))).toBeNull();
  });
});
