// flair#1586 / #1581 — adopt persist must keep mqtt.network in the
// first-repair key order (port, securePort, mtls). A SET_CONFIG-less
// detach with MQTT_* re-adds deleted null ports after mtls; this helper
// rewrites only those scalar lines.
import { describe, expect, test } from "bun:test";
import { load as parseYaml } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stabilizeMqttNetworkKeyOrder } from "../../src/lib/stabilize-mqtt-network.ts";

function mqttNetworkKeys(yamlText: string): string[] {
  const parsed = parseYaml(yamlText) as { mqtt?: { network?: Record<string, unknown> } };
  return Object.keys(parsed?.mqtt?.network ?? {});
}

const SETTLED = `---
http:
  port: 19926
mqtt:
  network:
    port: null
    securePort: null
    mtls: false
  webSocket: false
  requireAuthentication: true
`;

const DETACH_REORDERED = `---
http:
  port: 19926
mqtt:
  network:
    mtls: false
    port: null
    securePort: null
  webSocket: false
  requireAuthentication: true
`;

describe("stabilizeMqttNetworkKeyOrder (flair#1586 / #1581)", () => {
  test("already-settled port, securePort, mtls is a byte no-op", () => {
    const { text, changed } = stabilizeMqttNetworkKeyOrder(SETTLED);
    expect(changed).toBe(false);
    expect(text).toBe(SETTLED);
  });

  test("detach mtls-first order is rewritten to the settled order", () => {
    const { text, changed } = stabilizeMqttNetworkKeyOrder(DETACH_REORDERED);
    expect(changed).toBe(true);
    expect(mqttNetworkKeys(text)).toEqual(["port", "securePort", "mtls"]);
    expect(text).toBe(SETTLED);
  });

  test("preserves extra mqtt.network keys after the preferred three", () => {
    const extra = `mqtt:
  network:
    mtls: false
    extra: 1
    port: null
    securePort: null
`;
    const { text, changed } = stabilizeMqttNetworkKeyOrder(extra);
    expect(changed).toBe(true);
    expect(mqttNetworkKeys(text)).toEqual(["port", "securePort", "mtls", "extra"]);
    expect(text).toContain("    extra: 1");
  });

  test("preserves CRLF and a missing trailing newline", () => {
    const crlf = DETACH_REORDERED.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
    const { text, changed } = stabilizeMqttNetworkKeyOrder(crlf);
    expect(changed).toBe(true);
    expect(text.includes("\r\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(false);
    expect(mqttNetworkKeys(text.replace(/\r\n/g, "\n"))).toEqual(["port", "securePort", "mtls"]);
  });

  test("fail-closed on nested mqtt.network values, comments, and missing mqtt", () => {
    expect(stabilizeMqttNetworkKeyOrder("http:\n  port: 1\n")).toEqual({
      text: "http:\n  port: 1\n",
      changed: false,
    });
    const nested = `mqtt:
  network:
    mtls:
      required: false
    port: null
`;
    expect(stabilizeMqttNetworkKeyOrder(nested).changed).toBe(false);
    const commented = `mqtt:
  network:
    mtls: false
    # keep
    port: null
    securePort: null
`;
    expect(stabilizeMqttNetworkKeyOrder(commented).changed).toBe(false);
  });
});

describe("doctor --fix adopt keeps MQTT_* and restabilizes mqtt.network", () => {
  test("repairLaunchdManagement calls stabilizeMqttNetworkKeyOrder", () => {
    const cliSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8");
    expect(cliSrc).toMatch(/stabilizeMqttNetworkKeyOrder/);
    expect(cliSrc).toMatch(/if \(changed\) writeFileAtomic\(cfgPath/);
  });

  test("the Darwin adopt detach keeps MQTT_* from buildDirectSpawnEnv", () => {
    const darwinSrc = readFileSync(
      join(import.meta.dir, "..", "integration", "doctor-fix-launchd-darwin.test.ts"),
      "utf8",
    );
    expect(darwinSrc).toMatch(/buildDirectSpawnEnv\(/);
    expect(darwinSrc).not.toMatch(/delete env\.MQTT_NETWORK_PORT/);
    expect(darwinSrc).not.toMatch(/delete env\.MQTT_NETWORK_SECUREPORT/);
    expect(darwinSrc).not.toMatch(/delete env\.MQTT_WEBSOCKET/);
  });
});
