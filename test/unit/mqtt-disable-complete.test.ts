// flair#1586 — MQTT must be fully off on every Harper spawn path, and
// test-Harpers must not bind the shared inspector port a live Flair holds.
//
// The previous disable nulled only `mqtt.network.port`. Harper's mqtt
// component binds whenever `if (port || securePort)`, so the TLS listener
// on `mqtt.network.securePort` (8883) stayed up. Direct-spawn (`flair
// restart` / `flair upgrade`) omitted HARPER_SET_CONFIG and restored the
// defaults entirely.
//
// Wiring, not a live Harper: the three SET_CONFIG builders and
// buildDirectSpawnEnv are the doors. Reading the source finds a missing
// door that a runtime test of one path would not.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDirectSpawnEnv } from "../../src/cli.ts";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const cliSrc = stripComments(readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8"));
const lifecycleSrc = stripComments(
  readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8"),
);

describe("MQTT is fully disabled on every production spawn path (flair#1586)", () => {
  test("one shared MQTT_DISABLED_CONFIG nulls both ports and the WebSocket path", () => {
    expect(cliSrc).toMatch(/const MQTT_DISABLED_CONFIG\s*=\s*\{/);
    expect(cliSrc).toMatch(/network:\s*\{\s*port:\s*null,\s*securePort:\s*null\s*\}/);
    expect(cliSrc).toMatch(/webSocket:\s*false/);
  });

  test("all three HARPER_SET_CONFIG builders use MQTT_DISABLED_CONFIG", () => {
    const uses = [...cliSrc.matchAll(/mqtt:\s*MQTT_DISABLED_CONFIG/g)];
    expect(uses.length).toBe(3);
    expect(cliSrc).not.toMatch(/mqtt:\s*\{\s*network:\s*\{\s*port:\s*null\s*\}/);
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
