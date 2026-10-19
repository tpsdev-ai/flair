/**
 * mqtt-off-isolated-deploy.test.ts — the deploy channel turns MQTT off when the
 * deployed application is ISOLATED, through Harper's real deploy_component,
 * against a REAL Harper.
 *
 * When the root configuration marks an application `isolated: true`, Harper
 * runs it in a dedicated worker, and its deploy_component of that application
 * restarts only that worker (components/operations.js `restartScope`;
 * server/threads/manageThreads.js `restartWorkers` skips the shared workers).
 * The shared HTTP workers register the MQTT listeners, so the deploy's own
 * restart leaves them as they were. deploy()'s post-restart step
 * (src/mqtt-off-deploy.ts ensureMqttListenersOff) reads the target's
 * configuration, sees the application is isolated, restarts the shared worker
 * threads through `restart_service`, follows Harper's job to completion, and
 * passes only when the authenticated MQTT-over-WebSocket check gets Harper's
 * own answer for a disabled MQTT-over-WebSocket path ("off").
 *
 * The test-Harper runs with MQTT over WebSocket on, an HTTPS port and UDS
 * mirrors (what Harper requires before it admits an isolated application), and
 * a root configuration that marks two test components, `isoa` and `isob`,
 * isolated. Each is deployed by the whole deploy() path, which runs the real
 * Harper CLI (`harper deploy`) against this Harper's operations API, so Harper's
 * own deploy_component chooses the restart scope. The test components have no
 * dependencies; their install entry (the `node dist/fabric-npm-install.js`
 * command flair's deploy passes Harper) does nothing.
 *
 *   1. `isoa` with the post-restart step off: Harper starts a dedicated worker
 *      for it and restarts no shared worker (system_information's thread list:
 *      the shared worker thread ids are unchanged), so MQTT over WebSocket is
 *      still served although the configuration is off.
 *   2. `isob` with the step on: deploy() restarts the shared workers (a new
 *      shared worker thread id appears) and the real check finds MQTT over
 *      WebSocket off.
 *
 * Mutation check: skip the post-restart step in deploy() and step 2's
 * assertions go red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { REQUIRED_PACKAGE_FILES, deploy } from "../../src/deploy";
import { probeMqttOverWebSocket } from "../../src/mqtt-off-deploy";

let harper: HarperInstance;
// Harper's UDS mirror path for an isolated worker lives under the instance's
// root path and must fit the platform's socket-path limit, so the instance
// root is a short directory under the temp dir (removed in afterAll).
let instanceRoot: string;
const temps: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port as number;
      s.close(() => resolve(port));
    });
  });
}

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

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${body.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

interface ThreadRow { threadId: number; name: string; application?: string }
async function threads(): Promise<ThreadRow[]> {
  const info = await op({ operation: "system_information", attributes: ["threads"] });
  return (info.threads ?? []) as ThreadRow[];
}
const sharedWorkerIds = (rows: ThreadRow[]) => rows.filter((t) => t.name === "http" && !t.application).map((t) => t.threadId).sort();

/** A deployable test component: no dependencies, a no-op install entry, and the real Harper CLI beside it. */
function testComponent(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `flair-iso-${name}-`));
  temps.push(dir);
  for (const f of REQUIRED_PACKAGE_FILES) {
    const p = join(dir, f);
    if (f.endsWith(".yaml")) writeFileSync(p, "rest: true\n");
    else mkdirSync(p, { recursive: true });
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", files: ["dist/", "schemas/", "config.yaml"] }));
  writeFileSync(join(dir, "dist", "fabric-npm-install.js"), "process.exit(0);\n");
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(join(process.cwd(), "node_modules", "harper"), join(dir, "node_modules", "harper"), "dir");
  return dir;
}

async function deployComponent(name: string, mqttCheck: boolean, progress: string[]) {
  await deploy({
    target: harper.opsURL, // the Harper CLI sends deploy_component here
    opsUrl: harper.opsURL,
    mqttCheckUrl: harper.httpURL, // MQTT over WebSocket shares the HTTP port
    project: name,
    fabricUser: harper.admin.username,
    fabricPassword: harper.admin.password,
    packageRoot: testComponent(name),
    replicated: false,
    verify: false,
    mqttCheck,
    mqttCheckTimeoutMs: 30_000,
    harperRuntime: nodeBin(),
    onProgress: (m) => progress.push(m),
  });
}

beforeAll(async () => {
  instanceRoot = mkdtempSync(join(tmpdir(), "fi-"));
  const securePort = await freePort();
  harper = await startHarper({
    installDir: instanceRoot,
    mqttWebSocket: true,
    env: { HTTP_SECUREPORT: `127.0.0.1:${securePort}`, TLS_UNIXDOMAINSOCKETS: "true" },
    appendRootConfigYaml: "isoa:\n  isolated: true\nisob:\n  isolated: true\n",
  });
  assertOwnInstance(harper);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (instanceRoot) rmSync(instanceRoot, { recursive: true, force: true, maxRetries: 4 });
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
}, 60_000);

describe("MQTT off when the deployed application is isolated (real Harper deploy_component)", () => {
  test("Harper's deploy of an isolated application restarts only its worker and leaves MQTT served; deploy()'s post-restart step restarts the shared workers and the real check finds MQTT over WebSocket off", async () => {
    const config = await op({ operation: "get_configuration" });
    expect(config?.isoa?.isolated).toBe(true);
    expect(config?.mqtt?.webSocket, "mqtt.webSocket before").toBe(true);
    expect((await probeMqttOverWebSocket(harper.httpURL, { user: harper.admin.username, password: harper.admin.password })).outcome, "MQTT over WebSocket is served before").toBe("served");
    const before = sharedWorkerIds(await threads());
    expect(before.length, "a shared HTTP worker").toBeGreaterThan(0);

    // 1. The real deploy of an isolated application, without the post-restart step.
    const first: string[] = [];
    await deployComponent("isoa", false, first);
    const afterFirst = await threads();
    expect(afterFirst.some((t) => t.application === "isoa"), "Harper started a dedicated worker for isoa").toBe(true);
    expect(sharedWorkerIds(afterFirst), "Harper's deploy restarted no shared worker").toEqual(before);
    expect((await op({ operation: "get_configuration" }))?.mqtt?.webSocket, "the configuration is off").toBe(false);
    expect((await probeMqttOverWebSocket(harper.httpURL, { user: harper.admin.username, password: harper.admin.password })).outcome, "MQTT over WebSocket is still served after Harper's scoped restart").toBe("served");

    // 2. The real deploy of another isolated application, with the step.
    const second: string[] = [];
    await deployComponent("isob", true, second);
    const log = second.join("\n");
    expect(log).toContain("isob is an isolated application");
    expect(log).toContain("restarting the shared HTTP worker threads");
    expect(log).toContain("MQTT listeners checked off");
    const afterSecond = await threads();
    expect(afterSecond.some((t) => t.application === "isob"), "Harper started a dedicated worker for isob").toBe(true);
    expect(sharedWorkerIds(afterSecond).some((id) => !before.includes(id)), "a shared worker was replaced").toBe(true);
    const finalCheck = await probeMqttOverWebSocket(harper.httpURL, { user: harper.admin.username, password: harper.admin.password });
    expect(finalCheck.outcome, `MQTT over WebSocket after deploy() (${finalCheck.detail})`).toBe("off");
  }, 300_000);
});
