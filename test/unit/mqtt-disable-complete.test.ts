// flair#1586 — MQTT must be fully off on every Harper spawn path and on the
// component-deployment channel, and test-Harpers must not bind the shared
// inspector port a live Flair holds.
//
// The previous disable nulled only `mqtt.network.port`. Harper's mqtt
// component binds whenever `if (port || securePort)`, so the TLS listener
// on `mqtt.network.securePort` (8883) stayed up. Direct-spawn (`flair
// restart` / `flair upgrade`) omitted HARPER_SET_CONFIG and restored the
// defaults entirely.
//
// Wiring, not a live Harper: the three SET_CONFIG builders, buildDirectSpawnEnv
// and the deploy channel's set_configuration are the doors. Reading the source
// finds a missing door that a runtime test of one path would not. The deploy
// channel's requests are also checked at the HTTP boundary
// (test/unit/deploy-mqtt-off.test.ts) and against real Harpers
// (test/integration/mqtt-off-deploy-doctor.test.ts,
// test/integration/mqtt-off-isolated-deploy.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDirectSpawnEnv } from "../../src/cli.ts";
import { MQTT_DISABLED_CONFIG, MQTT_DISABLED_SET_CONFIGURATION } from "../../src/lib/mqtt-config.ts";
import { buildMqttOffOperation } from "../../src/deploy.ts";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const cliSrc = stripComments(readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8"));
const mqttConfigSrc = stripComments(readFileSync(join(import.meta.dir, "..", "..", "src", "lib", "mqtt-config.ts"), "utf8"));
const deploySrc = stripComments(readFileSync(join(import.meta.dir, "..", "..", "src", "mqtt-off-deploy.ts"), "utf8"));
// flair#1636 (epic #1618): `flair init`'s two HARPER_SET_CONFIG builders moved
// to src/commands/init.ts, so "every production spawn path" now spans two files.
const initSrc = stripComments(readFileSync(join(import.meta.dir, "..", "..", "src", "commands", "init.ts"), "utf8"));
const spawnSrc = `${cliSrc}\n${initSrc}`;
const lifecycleSrc = stripComments(
  readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8"),
);

describe("MQTT is fully disabled on every production spawn path (flair#1586)", () => {
  test("one shared MQTT_DISABLED_CONFIG nulls both ports and the WebSocket path", () => {
    expect(mqttConfigSrc).toMatch(/export const MQTT_DISABLED_CONFIG\s*=\s*\{/);
    expect(mqttConfigSrc).toMatch(/network:\s*\{\s*port:\s*null,\s*securePort:\s*null\s*\}/);
    expect(mqttConfigSrc).toMatch(/webSocket:\s*false/);
    expect(MQTT_DISABLED_CONFIG).toEqual({ network: { port: null, securePort: null }, webSocket: false });
    // cli.ts uses the shared constant rather than a copy of its own.
    expect(cliSrc).toMatch(/import \{ MQTT_DISABLED_CONFIG \} from "\.\/lib\/mqtt-config\.js"/);
    expect(cliSrc).not.toMatch(/const MQTT_DISABLED_CONFIG\s*=/);
  });

  test("the deploy channel sends the same configuration as set_configuration parameters", () => {
    expect(MQTT_DISABLED_SET_CONFIGURATION).toEqual({
      mqtt_network_port: null,
      mqtt_network_securePort: null,
      mqtt_webSocket: false,
    });
    expect(buildMqttOffOperation(false)).toEqual({ operation: "set_configuration", ...MQTT_DISABLED_SET_CONFIGURATION });
    expect(buildMqttOffOperation(true)).toEqual({ operation: "set_configuration", ...MQTT_DISABLED_SET_CONFIGURATION, replicated: true });
    expect(deploySrc).toMatch(/\.\.\.MQTT_DISABLED_SET_CONFIGURATION/);
  });

  test("all three HARPER_SET_CONFIG builders use MQTT_DISABLED_CONFIG", () => {
    const uses = [...spawnSrc.matchAll(/mqtt:\s*MQTT_DISABLED_CONFIG/g)];
    expect(uses.length).toBe(3);
    expect(spawnSrc).not.toMatch(/mqtt:\s*\{\s*network:\s*\{\s*port:\s*null\s*\}/);
  });

  test("buildDirectSpawnEnv re-asserts the disable via MQTT_* env vars", () => {
    const env = buildDirectSpawnEnv({
      dataDir: "/data",
      modelsDir: "/models",
      httpPort: 19926,
      opsPort: 19925,
      opsBindHost: "127.0.0.1",
      adminUser: "admin",
    });
    expect(env.MQTT_NETWORK_PORT).toBe("null");
    expect(env.MQTT_NETWORK_SECUREPORT).toBe("null");
    expect(env.MQTT_WEBSOCKET).toBe("false");
  });

  test("launchd plist and flair init re-assert the same MQTT_* env vars", () => {
    // One plist writer, one shape (flair#1693): the inline branch is gone, so
    // there is exactly ONE MQTT_* block in cli.ts, and it serves both init and
    // the doctor repair.
    const plistKeys = [...cliSrc.matchAll(/<key>MQTT_NETWORK_PORT<\/key>/g)];
    expect(plistKeys.length).toBe(1);
    expect(cliSrc).toMatch(/<key>MQTT_NETWORK_SECUREPORT<\/key><string>null<\/string>/);
    expect(cliSrc).toMatch(/<key>MQTT_WEBSOCKET<\/key><string>false<\/string>/);
    expect(cliSrc).toMatch(/MQTT_NETWORK_PORT:\s*"null"/);
    expect(cliSrc).toMatch(/MQTT_NETWORK_SECUREPORT:\s*"null"/);
    expect(cliSrc).toMatch(/MQTT_WEBSOCKET:\s*"false"/);
  });
});

describe("test-Harper port isolation (flair#1586)", () => {
  test("startHarper disables MQTT on both TCP and TLS", () => {
    expect(lifecycleSrc).toMatch(/MQTT_NETWORK_PORT:\s*"null"/);
    expect(lifecycleSrc).toMatch(/MQTT_NETWORK_SECUREPORT:\s*"null"/);
    expect(lifecycleSrc).toMatch(/MQTT_WEBSOCKET:\s*"false"/);
  });

  test("startHarper disables the Node inspector and does not spawn `harper dev`", () => {
    // `harper dev` sets DEV_MODE, which opens inspector on 9229 even when
    // threads.debug is false. Test-Harpers must use `harper run`.
    expect(lifecycleSrc).toMatch(/THREADS_DEBUG:\s*"false"/);
    expect(lifecycleSrc).toMatch(/HARPER_BIN,\s*"run",\s*"\."/);
    expect(lifecycleSrc).not.toMatch(/HARPER_BIN,\s*"dev",\s*"\."/);
  });
});
