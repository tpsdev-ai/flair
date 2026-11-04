/**
 * mqtt-off-deploy-doctor.test.ts — the component-deployment channel's request
 * sets Harper's MQTT listeners off in the instance's configuration, and `flair
 * doctor` reports what the saved configuration starts — against a REAL Harper
 * and the REAL built CLI.
 *
 * The Harper here starts with MQTT over WebSocket ON in its own configuration
 * file (StartHarperOptions.mqttWebSocket). Then:
 *   1. `flair doctor` names the MQTT listener and counts it as an issue;
 *   2. the deploy channel's own request (applyMqttOffConfiguration, the call
 *      `flair deploy` / `flair upgrade --target` make before deploying) is sent
 *      to this instance's operations API: its configuration then has every
 *      MQTT listener off, and `flair doctor` passes its configuration check —
 *      while the worker threads, not yet restarted, still accept an MQTT
 *      session. In that state doctor's "MQTT listeners (configuration)"
 *      section prints its note: it reads the saved configuration, not the
 *      running listeners;
 *   3. restarting the worker threads, as the deploy's restart does, stops the
 *      MQTT-over-WebSocket path: an MQTT session that was accepted before is no
 *      longer served (checked with the test's own MQTT client; flair does not
 *      probe the listeners).
 * test/unit/deploy-mqtt-off.test.ts checks that deploy() sends that request,
 * before Harper deploys, at the HTTP boundary.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js must exist
 * (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { nodeBin } from "../helpers/node-runtime";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { MQTT_REASON, MqttClient } from "../helpers/mqtt-client";
import { applyMqttOffConfiguration } from "../../src/deploy";
import { MQTT_CONFIGURATION_NOTE, MQTT_LISTENERS_OFF_LINE } from "../../src/lib/mqtt-listener-doctor";

const CLI = join(process.cwd(), "dist", "cli.js");

let harper: HarperInstance;
let cliHome: string;

interface RunResult { code: number | null; stdout: string; stderr: string }

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

function runDoctor(): Promise<RunResult> {
  return runCli(["doctor", "--port", new URL(harper.httpURL).port]);
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: cliHome,
      FLAIR_URL: harper.httpURL,
      FLAIR_OPS_PORT: new URL(harper.opsURL).port,
      FLAIR_TOKEN: "",
      FLAIR_ADMIN_PASS: harper.admin.password,
      NO_COLOR: "1",
      FLAIR_TARGET: "",
      FLAIR_OPS_TARGET: "",
      ...extraEnv,
    };
    const child = spawn(nodeBin({ env }), [CLI, ...args], { env, timeout: 20_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), 20_000, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function issueCount(stdout: string): number {
  if (/No issues found/.test(stdout)) return 0;
  const m = stdout.match(/(\d+) issues? found/);
  if (!m) throw new Error(`no summary line in doctor output:\n${stdout}`);
  return Number(m[1]);
}

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function mqttConfig(): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ operation: "get_configuration" }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status).toBe(200);
  return (await res.json())?.mqtt;
}

/** CONNECT over MQTT-over-WebSocket with an administrator's credential: the CONNACK code, or why there was none. */
async function mqttSession(): Promise<number | string> {
  const { client, opened } = await MqttClient.open(`${harper.httpURL.replace(/^http/, "ws")}/`, basic());
  try {
    if (!opened) return "not opened";
    const ack = await client.connect({ clientId: `mqtt-off-${randomUUID()}`, ms: 3_000 });
    return ack.kind === "answered" ? ack.value : ack.kind;
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  harper = await startHarper({ mqttWebSocket: true });
  assertOwnInstance(harper);
  cliHome = await mkdtemp(join(tmpdir(), "flair-mqtt-off-doctor-home-"));
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, 30_000);

describe("MQTT off in a component deployment (real CLI + real spawned Harper)", () => {
  test("doctor reports the MQTT listener; the deploy channel's request turns it off; doctor passes; the worker restart stops serving MQTT", async () => {
    // The instance under test serves MQTT over WebSocket from its own configuration.
    expect((await mqttConfig())?.webSocket, "mqtt.webSocket before").toBe(true);
    expect(await mqttSession(), "an administrator's MQTT session before").toBe(MQTT_REASON.SUCCESS);

    // 1. doctor names the listener and counts it.
    const on = await runDoctor();
    expect(on.stdout).toContain("MQTT listeners");
    expect(on.stdout).toContain("MQTT over WebSocket on the HTTP port (mqtt.webSocket)");
    expect(on.stdout).toContain('"operation":"set_configuration"');
    expect(on.stdout).not.toContain(MQTT_LISTENERS_OFF_LINE);
    const onCount = issueCount(on.stdout);

    // 2. The deploy channel's request, as deploy() sends it (replicated with the
    //    deploy; this standalone instance answers that it has no replication and
    //    is then set on its own).
    const progress: string[] = [];
    await applyMqttOffConfiguration({
      url: harper.opsURL,
      fabricUser: harper.admin.username,
      fabricPassword: harper.admin.password,
      replicated: true,
      onProgress: (m) => progress.push(m),
    });
    expect(progress.join("\n")).toContain("has no replication");
    const mqtt = await mqttConfig();
    expect(mqtt?.webSocket, "mqtt.webSocket after").toBe(false);
    expect(mqtt?.network?.port ?? null, "mqtt.network.port after").toBeNull();
    expect(mqtt?.network?.securePort ?? null, "mqtt.network.securePort after").toBeNull();
    expect(mqtt?.requireAuthentication, "the rest of the mqtt section is left as it was").toBe(true);

    const off = await runDoctor();
    expect(off.stderr, off.stderr).toBe("");
    expect(off.stdout).toContain(MQTT_LISTENERS_OFF_LINE);
    expect(off.stdout).not.toContain("MQTT over WebSocket on the HTTP port");
    expect(issueCount(off.stdout), "turning MQTT off did not move the summary by one").toBe(onCount - 1);

    // The saved configuration is off, but the worker threads have not
    // restarted: an MQTT session is still accepted. Doctor's section says it
    // read the saved configuration, not the running listeners.
    expect(await mqttSession(), "an administrator's MQTT session while the workers keep the old listeners").toBe(MQTT_REASON.SUCCESS);
    expect(off.stdout).toContain("MQTT listeners (configuration)");
    expect(off.stdout.replace(/\s+/g, " ")).toContain(MQTT_CONFIGURATION_NOTE);

    // 3. The deploy's restart (restart=true) restarts the HTTP worker threads,
    //    which register the MQTT listeners.
    const restart = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: JSON.stringify({ operation: "restart_service", service: "http_workers" }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(restart.status, await restart.text()).toBe(200);
    let after: number | string = MQTT_REASON.SUCCESS;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      after = await mqttSession();
      if (after !== MQTT_REASON.SUCCESS) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(after, "an MQTT session is still served after the worker restart").not.toBe(MQTT_REASON.SUCCESS);
    expect(typeof after === "string", `no MQTT CONNACK at all (got ${after})`).toBe(true);
  }, 240_000);
});
