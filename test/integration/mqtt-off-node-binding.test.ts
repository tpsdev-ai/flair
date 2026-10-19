/**
 * mqtt-off-node-binding.test.ts — the deploy channel's post-restart check
 * verifies the node at the operations API URL's host, by address, against TWO
 * REAL Harpers (src/mqtt-off-deploy.ts mqttCheckAddress).
 *
 * The check's address comes from the configuration that host's operations API
 * returns: that host, on the HTTP port the configuration names. A URL given for
 * the check is refused, before any check is sent, unless it names that host and
 * one of those ports, so the configuration read and the WebSocket check cannot
 * be split across two instances by choosing a check URL.
 *
 * Harper 1 starts with MQTT over WebSocket on; the deploy channel's own
 * request then sets its configuration off, and its worker threads are not
 * restarted, so it still serves MQTT over WebSocket. Harper 2 runs with MQTT
 * off. Both listen on 127.0.0.1, on different ports.
 *   1. The operations API of Harper 1 with Harper 2's HTTP URL as the check URL
 *      (Harper 1's configuration is off and Harper 2's WebSocket answers off)
 *      is refused before any check is sent: ensureMqttListenersOff,
 *      verifyNodeMqttListenersOff, and the real CLI (`flair deploy
 *      --verify-mqtt-only --ops-target <Harper 1> --mqtt-check-url <Harper 2>`,
 *      exit 1).
 *   2. With no check URL, the check is sent to Harper 1's host on the HTTP
 *      port Harper 1's configuration names, and reports MQTT still served
 *      there.
 *
 * Build prerequisite: dist/cli.js (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { nodeBin } from "../helpers/node-runtime";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { applyMqttOffConfiguration, ensureMqttListenersOff, probeMqttOverWebSocket, verifyNodeMqttListenersOff, type MqttProbeOutcome } from "../../src/mqtt-off-deploy";

const CLI = join(process.cwd(), "dist", "cli.js");

let harper1: HarperInstance;
let harper2: HarperInstance;
let cliHome: string;

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

const credsOf = (h: HarperInstance) => ({ user: h.admin.username, password: h.admin.password });

/** A probe that records each address it is sent to, then runs the real check with `h`'s credential. */
function recordingProbe(h: HarperInstance, sent: string[]): (url: string) => Promise<MqttProbeOutcome> {
  return async (url) => {
    sent.push(url);
    return probeMqttOverWebSocket(url, { ...credsOf(h), timeoutMs: 5_000 });
  };
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], extraEnv: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const env: Record<string, string | undefined> = { ...process.env, HOME: cliHome, NO_COLOR: "1", FLAIR_TARGET: "", FLAIR_OPS_TARGET: "", ...extraEnv };
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

beforeAll(async () => {
  harper1 = await startHarper({ mqttWebSocket: true });
  assertOwnInstance(harper1);
  harper2 = await startHarper();
  assertOwnInstance(harper2);
  cliHome = await mkdtemp(join(tmpdir(), "flair-mqtt-off-binding-home-"));
  // Harper 1: the configuration off, the worker threads not restarted.
  await applyMqttOffConfiguration({ url: harper1.opsURL, fabricUser: harper1.admin.username, fabricPassword: harper1.admin.password, replicated: false });
}, 240_000);

afterAll(async () => {
  if (harper1) await stopHarper(harper1);
  if (harper2) await stopHarper(harper2);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, 60_000);

describe("the post-restart MQTT check verifies the node at the operations API URL's host (two real Harpers)", () => {
  test("Harper 1's operations API with Harper 2's HTTP URL as the check URL is refused before any check is sent", async () => {
    // The two observations the check URL would pair: Harper 2 answers off; Harper 1 still serves.
    expect((await probeMqttOverWebSocket(harper2.httpURL, credsOf(harper2))).outcome, "Harper 2's WebSocket check").toBe("off");
    expect((await probeMqttOverWebSocket(harper1.httpURL, credsOf(harper1))).outcome, "Harper 1's WebSocket check").toBe("served");

    const sent: string[] = [];
    const base = { url: harper1.opsURL, fabricUser: harper1.admin.username, fabricPassword: harper1.admin.password, checkUrl: harper2.httpURL, probe: recordingProbe(harper2, sent) };
    let deployCheck: Error | undefined;
    try { await ensureMqttListenersOff({ ...base, project: "flair", replicated: false, checkTimeoutMs: 1_000 }); } catch (err) { deployCheck = err as Error; }
    expect(deployCheck?.message).toContain("the MQTT-over-WebSocket check of the node at 127.0.0.1 was not sent");
    expect(deployCheck?.message).toContain("does not name the operations API URL's host (127.0.0.1) and an HTTP port that host's configuration names");
    let verifyOnly: Error | undefined;
    try { await verifyNodeMqttListenersOff(base); } catch (err) { verifyOnly = err as Error; }
    expect(verifyOnly?.message).toContain("was not sent");
    expect(sent, "no WebSocket check was sent").toEqual([]);

    const cli = await runCli(["deploy", "--verify-mqtt-only", "--ops-target", harper1.opsURL, "--mqtt-check-url", harper2.httpURL], {
      FABRIC_USER: harper1.admin.username,
      FABRIC_PASSWORD: harper1.admin.password,
    });
    expect(cli.code, `${cli.stdout}\n${cli.stderr}`).toBe(1);
    expect(cli.stderr).toContain("was not sent: the URL given for the MQTT check (--mqtt-check-url)");
    expect(cli.stdout).not.toContain("verified off");
  }, 120_000);

  test("with no check URL, the check is sent to Harper 1's host on the HTTP port its configuration names, and finds MQTT still served there", async () => {
    const sent: string[] = [];
    let thrown: Error | undefined;
    try {
      await verifyNodeMqttListenersOff({ url: harper1.opsURL, fabricUser: harper1.admin.username, fabricPassword: harper1.admin.password, probe: recordingProbe(harper1, sent) });
    } catch (err) {
      thrown = err as Error;
    }
    const harper1Address = `http://127.0.0.1:${new URL(harper1.httpURL).port}`;
    expect(sent).toEqual([harper1Address]);
    expect(thrown?.message).toContain(`${harper1Address} still serves MQTT over WebSocket (an MQTT CONNACK came back)`);
  }, 120_000);
});
