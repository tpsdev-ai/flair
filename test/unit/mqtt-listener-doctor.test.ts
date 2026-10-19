/**
 * mqtt-listener-doctor.test.ts — the `flair doctor` MQTT listener check
 * (src/lib/mqtt-listener-doctor.ts) and the reading of an instance's `mqtt`
 * configuration section it rests on (src/lib/mqtt-config.ts).
 *
 * The check decides from the instance's root configuration, in Harper's own
 * terms (server/mqtt.ts `handleApplication`): a WebSocket path when
 * `mqtt.webSocket` is truthy, a TCP listener when `mqtt.network.port` is, a TLS
 * listener when `mqtt.network.securePort` is, and nothing when there is no
 * `mqtt` section. It reads the saved configuration, not the running
 * listeners, and every line it prints says so and names the live check
 * (`flair deploy --verify-mqtt-only`).
 * test/integration/mqtt-off-deploy-doctor.test.ts runs it through the real CLI
 * against a real Harper, including one whose configuration is off while its
 * worker threads still serve MQTT.
 */
import { describe, expect, test } from "bun:test";
import { MQTT_DISABLED_CONFIG, mqttListenersOn } from "../../src/lib/mqtt-config.ts";
import { MQTT_CONFIGURATION_NOTE, MQTT_LISTENERS_OFF_LINE, describeMqttListenerFinding, mqttListenerSection, readInstanceConfiguration } from "../../src/lib/mqtt-listener-doctor.ts";
import { rootConfigurationProblem } from "../../src/lib/mqtt-config.ts";

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

describe("readInstanceConfiguration and the doctor's MQTT listeners section", () => {
  const args = (fetchImpl: any) => ({ opsUrl: "http://127.0.0.1:1/", authHeader: "Basic x", fetchImpl, timeoutMs: 1000 });
  /** The sections every root configuration carries (a real get_configuration answer has these and more). */
  const ROOT = { http: { port: 9926 }, operationsApi: { network: { port: 9925 } }, rootPath: "/var/harper" };

  test("returns the root configuration get_configuration answers with", async () => {
    let sent: any;
    const read = await readInstanceConfiguration(args(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ ...ROOT, mqtt: HARPER_DEFAULTS });
    }));
    expect(sent).toEqual({ operation: "get_configuration" });
    expect(read).toEqual({ kind: "ok", config: { ...ROOT, mqtt: HARPER_DEFAULTS } });
  });

  test("a failed read, or an answer that is not a recognizable root configuration, is NOT RUN — never a pass", async () => {
    const cases: Array<[string, any]> = [
      ["HTTP 401", async () => new Response("no", { status: 401 })],
      ["an array", async () => Response.json([1, 2])],
      ["not JSON", async () => new Response("not json", { status: 200 })],
      ["a transport failure", async () => { throw new Error("ECONNREFUSED"); }],
      ["{}", async () => Response.json({})],
      ["an mqtt section alone", async () => Response.json({ mqtt: { webSocket: false, network: { port: null, securePort: null } } })],
      ["an error object", async () => Response.json({ error: "something" })],
    ];
    for (const [what, fetchImpl] of cases) {
      const read = await readInstanceConfiguration(args(fetchImpl));
      expect([what, read.kind]).toEqual([what, "not-run"]);
      const section = mqttListenerSection(read);
      expect([what, section.status]).toEqual([what, "not-run"]);
      expect(section.line).toContain("MQTT listeners: NOT RUN");
    }
    const empty = await readInstanceConfiguration(args(async () => Response.json({})));
    expect(empty).toEqual({ kind: "not-run", reason: "the answer is not a recognizable root configuration (it has no http, operationsApi, rootPath)" });
  });

  test("the section the doctor prints: the all-off line for MQTT off, the listeners and fix for MQTT on, each with the configuration note", () => {
    expect(mqttListenerSection({ kind: "ok", config: { ...ROOT, mqtt: MQTT_DISABLED_CONFIG } })).toEqual({ status: "ok", line: MQTT_LISTENERS_OFF_LINE, note: MQTT_CONFIGURATION_NOTE });
    const on = mqttListenerSection({ kind: "ok", config: { ...ROOT, mqtt: HARPER_DEFAULTS } });
    expect(on.status).toBe("issue");
    expect(on.note).toBe(MQTT_CONFIGURATION_NOTE);
    expect(on.fix).toContain("set_configuration");
    expect(on.fix).toContain("flair deploy --verify-mqtt-only");
    expect(mqttListenerSection({ kind: "not-run", reason: "x" }).note).toBe(MQTT_CONFIGURATION_NOTE);
  });

  test("the configuration note says the check reads the saved configuration, not the running listeners, and names the live check", () => {
    expect(MQTT_CONFIGURATION_NOTE).toContain("This reads the saved configuration, not the running listeners");
    expect(MQTT_CONFIGURATION_NOTE).toContain("worker threads that have not restarted since it changed keep serving MQTT");
    expect(MQTT_CONFIGURATION_NOTE).toContain("flair deploy --verify-mqtt-only");
  });

  test("a configured port is printed only as the integer it parses to", () => {
    expect(mqttListenersOn({ mqtt: { network: { port: "private-value", securePort: "0.0.0.0:8883" } } })).toEqual([
      "MQTT on TCP port (mqtt.network.port)",
      "MQTT on TLS port 8883 (mqtt.network.securePort)",
    ]);
  });

  test("rootConfigurationProblem checks only http, operationsApi and rootPath: an answer missing one is refused, any object with all three is accepted", () => {
    expect(rootConfigurationProblem(ROOT)).toBeNull();
    expect(rootConfigurationProblem({ ...ROOT, rootPath: "" })).toBe("it has no rootPath");
    expect(rootConfigurationProblem(null)).toBe("the answer is not an object");
    // Accepted although it is otherwise partial: the recognizer reads those three fields only.
    expect(rootConfigurationProblem({ http: {}, operationsApi: {}, rootPath: "/x" })).toBeNull();
  });
});
