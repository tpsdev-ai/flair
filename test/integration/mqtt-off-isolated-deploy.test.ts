/**
 * mqtt-off-isolated-deploy.test.ts — the deploy channel sets MQTT off and
 * requests the shared worker threads' restart when the deployed application is
 * ISOLATED, through Harper's real deploy_component, against a REAL Harper.
 *
 * When the root configuration marks an application `isolated: true`, Harper
 * runs it in a dedicated worker, and its deploy_component of a FRESH isolated
 * application (one Harper does not find already active) restarts only that
 * worker (components/operations.js `restartScope`;
 * server/threads/manageThreads.js `restartWorkers` skips the shared workers);
 * for an application it finds already active, Harper restarts every worker.
 * The shared HTTP workers start the MQTT listeners, so a fresh isolated
 * deploy's own restart leaves them as they were. deploy()'s post-restart step
 * (src/mqtt-off-deploy.ts completeMqttOff) reads the target's configuration,
 * sees the application is isolated, requests the shared worker threads'
 * restart through `restart_service`, follows Harper's job to completion, and
 * reports the configuration it set, the job and the saved configuration it
 * read back. It does not probe the listeners.
 *
 * The test-Harper runs with MQTT over WebSocket on, an HTTPS port and UDS
 * mirrors (what Harper requires before it admits an isolated application), and
 * a root configuration that marks three test components, `isoa`, `isob` and
 * `isoc`, isolated. Each is deployed by the whole deploy() path, which runs the real
 * Harper CLI (`harper deploy`) against this Harper's operations API, so Harper's
 * own deploy_component chooses the restart scope. The test components have no
 * dependencies; their install entry (the `node dist/fabric-npm-install.js`
 * command flair's deploy passes Harper) does nothing.
 *
 *   1. `isoa` with the post-restart step off: the configuration is written
 *      off (step 1), Harper starts a dedicated worker for it and restarts no
 *      shared worker (system_information's thread list: the shared worker
 *      thread ids are unchanged).
 *   2. `isob` with the step on: deploy() requests the shared workers' restart
 *      (a new shared worker thread id appears), and its report names the
 *      configuration it set, the job and the saved configuration it read back
 *      off, and says it does not probe the listeners.
 *   3. The standalone fallback: `isoc` is deployed with the step off (a fresh
 *      isolated deploy: no shared worker restarted), then the post-restart step
 *      (completeMqttOff) runs against this Harper with `replicated: true`, as
 *      a replicated deploy would run it. It is called directly because a
 *      replicated Harper deploy is itself refused by a standalone Harper. The
 *      operations requests it sends are recorded: the replicated
 *      restart_service, Harper's refusal of it ("Replication not
 *      implemented"), the local restart_service, and the get_job reads of that
 *      local job until it completes; a shared worker is replaced; and the
 *      report is exact.
 *
 * Mutation checks: skip the post-restart step in deploy(), or skip the shared
 * workers' restart for an isolated application, and step 2's assertions go
 * red; drop the standalone fallback and step 3's go red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { REQUIRED_PACKAGE_FILES, deploy } from "../../src/deploy";
import { MQTT_OFF_REPORT_LIMIT, completeMqttOff } from "../../src/mqtt-off-deploy";

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
    project: name,
    fabricUser: harper.admin.username,
    fabricPassword: harper.admin.password,
    packageRoot: testComponent(name),
    replicated: false,
    verify: false,
    mqttCheck,
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
    appendRootConfigYaml: "isoa:\n  isolated: true\nisob:\n  isolated: true\nisoc:\n  isolated: true\n",
  });
  assertOwnInstance(harper);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (instanceRoot) rmSync(instanceRoot, { recursive: true, force: true, maxRetries: 4 });
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
}, 60_000);

describe("MQTT off when the deployed application is isolated (real Harper deploy_component)", () => {
  test("Harper's deploy of a fresh isolated application restarts only its worker; deploy()'s post-restart step requests the shared workers' restart and reports the configuration it set and read back", async () => {
    const config = await op({ operation: "get_configuration" });
    expect(config?.isoa?.isolated).toBe(true);
    expect(config?.mqtt?.webSocket, "mqtt.webSocket before").toBe(true);
    const before = sharedWorkerIds(await threads());
    expect(before.length, "a shared HTTP worker").toBeGreaterThan(0);

    // 1. The real deploy of an isolated application, without the post-restart step.
    const first: string[] = [];
    await deployComponent("isoa", false, first);
    const afterFirst = await threads();
    expect(afterFirst.some((t) => t.application === "isoa"), "Harper started a dedicated worker for isoa").toBe(true);
    expect(sharedWorkerIds(afterFirst), "Harper's deploy restarted no shared worker").toEqual(before);
    const written = (await op({ operation: "get_configuration" }))?.mqtt;
    expect(written?.webSocket, "step 1 wrote mqtt.webSocket off").toBe(false);
    expect(written?.network?.port ?? null, "step 1 wrote mqtt.network.port off").toBeNull();
    expect(written?.network?.securePort ?? null, "step 1 wrote mqtt.network.securePort off").toBeNull();

    // 2. The real deploy of another isolated application, with the step.
    const second: string[] = [];
    await deployComponent("isob", true, second);
    const log = second.join("\n");
    expect(log).toContain("isob is an isolated application");
    expect(log).toContain("requesting a restart of the shared HTTP worker threads");
    const afterSecond = await threads();
    expect(afterSecond.some((t) => t.application === "isob"), "Harper started a dedicated worker for isob").toBe(true);
    expect(sharedWorkerIds(afterSecond).some((id) => !before.includes(id)), "a shared worker was replaced").toBe(true);
    const opsHost = new URL(harper.opsURL).host;
    const report = second.find((m) => m.startsWith("MQTT listeners configured off on"));
    expect(report, log).toMatch(new RegExp(
      `^MQTT listeners configured off on ${opsHost.replace(/\./g, "\\.")}; shared workers restart requested \\(job [A-Za-z0-9._-]+: ${opsHost.replace(/\./g, "\\.")} completed\\); ` +
        `the saved configuration on ${opsHost.replace(/\./g, "\\.")} reads off\\. `,
    ));
    expect(report!.endsWith(MQTT_OFF_REPORT_LIMIT)).toBe(true);
    expect(log).not.toMatch(/verified|is off on|listeners are off/i);
  }, 300_000);

  test("the standalone fallback: a replicated restart request is refused by this standalone Harper, the local restart is requested and its job followed, a shared worker is replaced, and the report is exact", async () => {
    // A fresh isolated deploy of isoc, without the post-restart step.
    const first: string[] = [];
    await deployComponent("isoc", false, first);
    const before = sharedWorkerIds(await threads());
    expect(before.length, "a shared HTTP worker").toBeGreaterThan(0);

    // The post-restart step as a replicated deploy runs it, with every
    // operations request and its answer recorded.
    const exchanges: Array<{ body: any; status: number; text: string }> = [];
    const recordingFetch = (async (input: any, init?: any) => {
      const res = await fetch(input, init);
      const text = await res.clone().text();
      exchanges.push({ body: JSON.parse(String(init?.body ?? "null")), status: res.status, text });
      return res;
    }) as unknown as typeof fetch;
    const progress: string[] = [];
    const { report } = await completeMqttOff({
      url: harper.opsURL,
      project: "isoc",
      fabricUser: harper.admin.username,
      fabricPassword: harper.admin.password,
      replicated: true,
      peers: [],
      fetchImpl: recordingFetch,
      onProgress: (m) => progress.push(m),
    });

    const restarts = exchanges.filter((e) => e.body?.operation === "restart_service");
    expect(restarts.map((e) => e.body), "a replicated restart request, then a local one").toEqual([
      { operation: "restart_service", service: "http_workers", scope: "", replicated: true },
      { operation: "restart_service", service: "http_workers", scope: "" },
    ]);
    // Harper accepts the replicated request as a job and refuses it there: the
    // job ends ERROR with "Replication not implemented." (bin/restart.ts asks
    // the standalone replication for the cluster's nodes before restarting).
    const replicatedAt = exchanges.indexOf(restarts[0]);
    const localAt = exchanges.indexOf(restarts[1]);
    const replicatedJobId = JSON.parse(restarts[0].text).job_id as string;
    expect(typeof replicatedJobId, "the replicated request was answered with a job").toBe("string");
    const replicatedReads = exchanges.slice(replicatedAt + 1, localAt).filter((e) => e.body?.operation === "get_job");
    expect(replicatedReads.length).toBeGreaterThan(0);
    expect(replicatedReads.every((e) => e.body.id === replicatedJobId)).toBe(true);
    const lastReplicatedRead = JSON.parse(replicatedReads.at(-1)!.text);
    const replicatedJob = Array.isArray(lastReplicatedRead) ? lastReplicatedRead[0] : lastReplicatedRead;
    expect(replicatedJob?.status).toBe("ERROR");
    expect(String(replicatedJob?.message)).toContain("Replication not implemented");
    expect(progress.join("\n")).toContain("has no replication; requesting the restart of that instance's shared workers alone");
    // The local job was read until it completed.
    const localJobId = JSON.parse(restarts[1].text).job_id as string;
    expect(typeof localJobId).toBe("string");
    const jobReads = exchanges.slice(localAt + 1).filter((e) => e.body?.operation === "get_job");
    expect(jobReads.length).toBeGreaterThan(0);
    expect(jobReads.every((e) => e.body.id === localJobId && e.status === 200)).toBe(true);
    expect(jobReads.at(-1)!.text).toContain(`Successfully completed job: ${localJobId}`);

    // A shared worker was replaced.
    expect(sharedWorkerIds(await threads()).some((id) => !before.includes(id)), "a shared worker was replaced").toBe(true);

    // The exact report.
    const opsHost = new URL(harper.opsURL).host;
    expect(report).toBe(
      `MQTT listeners configured off on ${opsHost}; shared workers restart requested (job ${localJobId}: ${opsHost} completed); ` +
        `the saved configuration on ${opsHost} reads off. ${MQTT_OFF_REPORT_LIMIT}`,
    );
  }, 300_000);
});
