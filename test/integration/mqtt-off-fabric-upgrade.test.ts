/**
 * mqtt-off-fabric-upgrade.test.ts — `flair upgrade --target`'s orchestrator
 * (fabricUpgrade(), src/fabric-upgrade.ts) composed with the REAL deploy()
 * (src/deploy.ts) against a REAL Harper: the operations API URL it is given
 * reaches deploy(), which writes the MQTT-off configuration there before the
 * deploy, reads it back after the deploy's restart, and reports it.
 *
 * Only what fabricUpgrade() would fetch from the network is local: the
 * registry lookups answer fixed versions, the deployed-version lookup answers
 * nothing, and npmInstall builds the staged package in place of npm — a
 * deployable test component named @tpsdev-ai/flair, with no dependencies and a
 * no-op install entry, and this repository's Harper beside it. deploy() is the
 * real one, called with exactly the options fabricUpgrade() passes; the test
 * adds only the runtime that runs the Harper CLI (node) and turns off the
 * served-API verification, which needs a real Flair component.
 *
 * The target is this Harper's operations URL (the Harper CLI sends
 * deploy_component there) and the operations API URL is given explicitly, as
 * `flair upgrade --target` resolves it. A deploy() that did not receive it
 * would derive another port from the target (port-1), reach no Harper, and
 * fail before deploying.
 *
 * A second run passes `verify: false` (`flair upgrade --target --no-verify`):
 * it reaches deploy(), which then skips its post-restart MQTT step and says so
 * (its served-API verification is skipped too). That run adds only the node
 * runtime to what fabricUpgrade() passes.
 *
 * Mutation checks: drop the operations API URL, or `verify`, from what
 * fabricUpgrade() passes to deploy() and this file goes red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { REQUIRED_PACKAGE_FILES, deploy, type DeployOptions } from "../../src/deploy";
import { fabricUpgrade } from "../../src/fabric-upgrade";
import { MQTT_OFF_REPORT_LIMIT } from "../../src/mqtt-off-deploy";

let harper: HarperInstance;

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

async function mqttSection(): Promise<any> {
  assertOwnInstance(harper);
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ operation: "get_configuration" }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status).toBe(200);
  return (await res.json())?.mqtt;
}

/** The staged package fabricUpgrade() hands deploy(): a deployable test component and this repository's Harper. */
function stageInto(dir: string): void {
  const root = join(dir, "node_modules", "@tpsdev-ai", "flair");
  mkdirSync(root, { recursive: true });
  for (const f of REQUIRED_PACKAGE_FILES) {
    const p = join(root, f);
    if (f.endsWith(".yaml")) writeFileSync(p, "rest: true\n");
    else mkdirSync(p, { recursive: true });
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "9.9.9", files: ["dist/", "schemas/", "config.yaml"] }));
  writeFileSync(join(root, "dist", "fabric-npm-install.js"), "process.exit(0);\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(process.cwd(), "node_modules", "harper"), join(root, "node_modules", "harper"), "dir");
}

const stagingDirs: string[] = [];

beforeAll(async () => {
  harper = await startHarper({ mqttWebSocket: true });
  assertOwnInstance(harper);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  while (stagingDirs.length) rmSync(stagingDirs.pop()!, { recursive: true, force: true });
}, 60_000);

describe("fabricUpgrade() into the real deploy() (local staging, real Harper)", () => {
  test("the given operations API URL reaches deploy(), which writes the MQTT-off configuration there and reads it back", async () => {
    expect((await mqttSection())?.webSocket, "mqtt.webSocket before").toBe(true);
    const deployCalls: DeployOptions[] = [];
    const log: string[] = [];
    const result = await fabricUpgrade(
      {
        target: harper.opsURL,
        opsUrl: harper.opsURL,
        project: "composedflair",
        fabricUser: harper.admin.username,
        fabricPassword: harper.admin.password,
        replicated: false,
      },
      {
        fetchLatestFlairVersion: async () => "9.9.9",
        fetchDeclaredHarperVersion: async () => "5.3.1",
        fetchDeployedVersion: async () => null,
        npmInstall: (dir: string) => { stagingDirs.push(dir); stageInto(dir); },
        deploy: (opts: DeployOptions) => {
          deployCalls.push(opts);
          return deploy({ ...opts, harperRuntime: nodeBin(), verify: false, mqttCheck: true });
        },
        log: (m: string) => log.push(m),
      },
    );
    expect(result.deployed, log.join("\n")).toBe(true);
    expect(deployCalls.length).toBe(1);
    expect(deployCalls[0].opsUrl, "fabricUpgrade() passed the operations API URL").toBe(harper.opsURL);

    // The configuration write reached this Harper.
    const mqtt = await mqttSection();
    expect(mqtt?.webSocket, "mqtt.webSocket after").toBe(false);
    expect(mqtt?.network?.port ?? null, "mqtt.network.port after").toBeNull();
    expect(mqtt?.network?.securePort ?? null, "mqtt.network.securePort after").toBeNull();

    // deploy() read it back and reported exactly what it set and requested.
    const opsHost = new URL(harper.opsURL).host;
    const report = log.find((m) => m.trim().startsWith("MQTT listeners configured off on"));
    expect(report?.trim(), log.join("\n")).toBe(
      `MQTT listeners configured off on ${opsHost}; shared workers restart requested (with the deploy's own restart); ` +
        `the saved configuration on ${opsHost} reads off. ${MQTT_OFF_REPORT_LIMIT}`,
    );
  }, 300_000);

  test("verify: false (flair upgrade --target --no-verify) reaches deploy(), which skips its post-restart MQTT step and says so", async () => {
    const deployCalls: DeployOptions[] = [];
    const log: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let result: Awaited<ReturnType<typeof fabricUpgrade>>;
    try {
      result = await fabricUpgrade(
        {
          target: harper.opsURL,
          opsUrl: harper.opsURL,
          project: "composedflair",
          fabricUser: harper.admin.username,
          fabricPassword: harper.admin.password,
          replicated: false,
          verify: false,
        },
        {
          fetchLatestFlairVersion: async () => "9.9.9",
          fetchDeclaredHarperVersion: async () => "5.3.1",
          fetchDeployedVersion: async () => null,
          npmInstall: (dir: string) => { stagingDirs.push(dir); stageInto(dir); },
          deploy: (opts: DeployOptions) => {
            deployCalls.push(opts);
            return deploy({ ...opts, harperRuntime: nodeBin() });
          },
          log: (m: string) => log.push(m),
        },
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(result!.deployed, log.join("\n")).toBe(true);
    expect(deployCalls[0].verify, "fabricUpgrade() passed verify: false").toBe(false);
    expect(warnings.join("\n")).toContain("the post-restart MQTT step did not run (--no-verify)");
    expect(log.join("\n")).not.toContain("MQTT listeners configured off on");
  }, 300_000);
});
