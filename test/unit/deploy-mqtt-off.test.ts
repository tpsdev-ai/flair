/**
 * deploy-mqtt-off.test.ts — `flair deploy` / `flair upgrade --target` turn the
 * target's MQTT listeners off and check them afterwards (src/mqtt-off-deploy.ts).
 *
 * Flair runs Harper with MQTT off. A component deployment does not go through
 * flair's local spawns, and a component's config.yaml cannot set the
 * instance's `mqtt` section, so deploy():
 *   1. sends the MQTT-off configuration to the target's operations API
 *      (`set_configuration`) before anything is deployed — a refusal, or a
 *      cluster node the answer names as failed, stops it there;
 *   2. after the deploy's restart, verifies the node the target URL reaches:
 *      reads its configuration (it must show the MQTT-off values), restarts
 *      the shared worker threads when the application is isolated (failing on
 *      a failure the job reports — a completed restart job is not proof of a
 *      peer's restart), and checks MQTT over WebSocket — passing only on
 *      Harper's answer for a disabled path ("off"), and failing, with the
 *      restart and check to run, when MQTT is still served or the check is
 *      inconclusive. Every other cluster node the replicated answers name is
 *      reported NOT VERIFIED with the check to run on it;
 *      `requireAllNodesVerified` turns that into a failure.
 * Every URL is scheme, host, port and path only: a user name, password, query
 * or fragment is refused before anything is sent. Errors quote a remote's
 * HTTP status, never its body, a job's message or a transport error's text.
 *
 * The whole deploy() path runs here against a REAL HTTP server standing in for
 * the target's operations API (the HTTP boundary), with a stub Harper binary
 * that records when it ran, so the CALLS in deploy() are what is under test.
 * The WebSocket check is injected (`mqttProbe`); probeMqttOverWebSocket itself
 * runs against real local servers in test/unit/mqtt-probe.test.ts and against
 * real Harpers in test/integration/mqtt-off-isolated-deploy.test.ts, which
 * drives Harper's own deploy_component of an isolated component. `flair upgrade --target`
 * reaches this deploy() (test/unit/fabric-upgrade.test.ts and
 * test/unit/upgrade-target-ops-url.test.ts check what it passes).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy, REQUIRED_PACKAGE_FILES } from "../../src/deploy.ts";
import { MQTT_DISABLED_SET_CONFIGURATION } from "../../src/lib/mqtt-config.ts";
import type { DeployOptions } from "../../src/deploy.ts";
import type { MqttProbeOutcome } from "../../src/mqtt-off-deploy.ts";

interface Received {
  body: any;
  authorization: string | null;
  /** Whether the stub Harper had already run when this request arrived. */
  harperHadRun: boolean;
}

let server: ReturnType<typeof Bun.serve>;
/** The operations API stand-in. */
let opsUrl: string;
/** The deploy target whose operations API is derived as `opsUrl` (port + 1, flair's port-1 convention). */
let target: string;
let received: Received[] = [];
type Handler = (body: any) => Response;
let handlers: Record<string, Handler> = {};
let harperRanMarker = "";
const temps: string[] = [];

const MQTT_OFF = { network: { port: null, securePort: null, mtls: false }, webSocket: false, requireAuthentication: true };
/** Harper's completed restart job: its own message, and for a replicated restart each node's (bin/restart.ts). */
const completedJob = (body: any, nodes: unknown[] = [{ node: "node-b", message: "Successfully completed job: peer-job-1" }]) =>
  Response.json([{ id: body.id, status: "COMPLETE", message: `Successfully completed job: ${body.id}`, ...(lastRestartWasReplicated ? { result: { replicated: nodes } } : {}) }]);
let lastRestartWasReplicated = false;
const defaults = (): Record<string, Handler> => ({
  set_configuration: () => Response.json({ message: "Configuration successfully set." }),
  get_configuration: () => Response.json({ mqtt: MQTT_OFF }),
  restart_service: (body) => { lastRestartWasReplicated = body.replicated === true; return Response.json({ message: "Restarting http_workers", job_id: "job-1" }); },
  get_job: (body) => completedJob(body),
});
const OFF: MqttProbeOutcome = { outcome: "off", detail: "test: Harper's answer for a disabled MQTT-over-WebSocket path" };
const SERVED: MqttProbeOutcome = { outcome: "served", detail: "test: CONNACK" };
const INCONCLUSIVE: MqttProbeOutcome = { outcome: "inconclusive", detail: "test: no answer" };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const text = await req.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { body = text; }
      received.push({ body, authorization: req.headers.get("authorization"), harperHadRun: existsSync(harperRanMarker) });
      const handler = handlers[body?.operation];
      return handler ? handler(body) : new Response(JSON.stringify({ error: `unexpected operation ${body?.operation}` }), { status: 400 });
    },
  });
  opsUrl = `http://127.0.0.1:${server.port}`;
  target = `http://127.0.0.1:${Number(server.port) + 1}`;
});

afterAll(() => {
  server.stop(true);
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A deployable package root whose `harper` binary writes a marker and exits 0. */
function synthPkgRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-deploy-mqtt-off-"));
  temps.push(dir);
  for (const f of REQUIRED_PACKAGE_FILES) {
    const p = join(dir, f);
    if (f.endsWith(".yaml")) writeFileSync(p, "port: 9926\n");
    else mkdirSync(p, { recursive: true });
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@tpsdev-ai/flair",
      version: "9.9.9-test",
      files: ["dist/", "schemas/", "templates/", "docs/", "config.yaml", "LICENSE", "README.md", "SECURITY.md"],
    }),
  );
  harperRanMarker = join(dir, ".harper-ran");
  const binDir = join(dir, "node_modules", "harper", "dist", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "harper.js"),
    `require("fs").writeFileSync(${JSON.stringify(harperRanMarker)}, process.argv.slice(2).join(" "));\nconsole.log("Successfully deployed");\n`,
  );
  return dir;
}

/** The check answers "not served"; the served-API verification is off, the MQTT check on. */
function base(over: Partial<DeployOptions> = {}): DeployOptions {
  return {
    target,
    fabricUser: "deploy-admin",
    fabricPassword: "not-a-real-password",
    packageRoot: synthPkgRoot(),
    verify: false,
    mqttCheck: true,
    mqttCheckTimeoutMs: 200,
    mqttProbe: async () => OFF,
    ...over,
  };
}

function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = original; } };
}

function reset(over: Record<string, Handler> = {}): void {
  received = [];
  lastRestartWasReplicated = false;
  handlers = { ...defaults(), ...over };
}

const ops = () => received.map((r) => r.body?.operation);

describe("step 1: deploy() sends the MQTT-off configuration before Harper deploys", () => {
  test("one set_configuration with every MQTT listener off, replicated with the deploy, under the deploy's credential, to the operations API derived from the target", async () => {
    reset();
    const result = await deploy(base());
    expect(result.dryRun).toBe(false);
    const set = received.filter((r) => r.body?.operation === "set_configuration");
    expect(set.length).toBe(1);
    expect(set[0].body).toEqual({
      operation: "set_configuration",
      mqtt_network_port: null,
      mqtt_network_securePort: null,
      mqtt_webSocket: false,
      replicated: true,
    });
    expect(set[0].body).toMatchObject(MQTT_DISABLED_SET_CONFIGURATION);
    expect(set[0].authorization).toBe(`Basic ${Buffer.from("deploy-admin:not-a-real-password").toString("base64")}`);
    expect(set[0].harperHadRun, "the configuration was sent after Harper deployed").toBe(false);
    expect(existsSync(harperRanMarker), "Harper deployed").toBe(true);
  }, 60_000);

  test("an explicit operations API URL (--ops-target) is used instead of the derived one", async () => {
    reset();
    await deploy(base({ target: "https://prod.acme.harperfabric.com", opsUrl }));
    expect(received[0].body).toMatchObject({ operation: "set_configuration", ...MQTT_DISABLED_SET_CONFIGURATION });
  }, 60_000);

  test("a standalone instance (no replication) is set on its own", async () => {
    reset({
      set_configuration: (body) => body.replicated === true
        ? new Response(JSON.stringify({ error: "Replication not implemented." }), { status: 500 })
        : Response.json({ message: "Configuration successfully set." }),
    });
    await deploy(base());
    expect(received.filter((r) => r.body?.operation === "set_configuration").map((r) => r.body)).toEqual([
      { operation: "set_configuration", ...MQTT_DISABLED_SET_CONFIGURATION, replicated: true },
      { operation: "set_configuration", ...MQTT_DISABLED_SET_CONFIGURATION },
    ]);
    expect(existsSync(harperRanMarker)).toBe(true);
  }, 60_000);

  test("a deploy with --no-replicated sends it to the origin only", async () => {
    reset();
    await deploy(base({ replicated: false }));
    expect(received[0].body).toEqual({ operation: "set_configuration", ...MQTT_DISABLED_SET_CONFIGURATION });
  }, 60_000);

  test("a target that refuses the configuration fails the deploy by name, and Harper never runs", async () => {
    reset({ set_configuration: () => new Response(JSON.stringify({ error: "Unable to update config" }), { status: 400 }) });
    await expect(deploy(base())).rejects.toThrow(/refused the MQTT-off configuration \(HTTP 400.*nothing was deployed.*--keep-mqtt-config/s);
    expect(existsSync(harperRanMarker), "Harper ran after the refusal").toBe(false);
  }, 60_000);

  test("a target that cannot be reached fails the deploy by name, and Harper never runs", async () => {
    reset();
    const unreachable = async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:9925 /private-path"), { code: "ECONNREFUSED" }); };
    let thrown: Error | undefined;
    try { await deploy(base({ operationsFetch: unreachable as any })); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toMatch(/could not send the MQTT-off configuration .*\(the request failed \(ECONNREFUSED\)\).*nothing was deployed/s);
    // The transport error's own text is never printed, only its code.
    expect(thrown?.message).not.toContain("10.0.0.9");
    expect(thrown?.message).not.toContain("private-path");
    expect(existsSync(harperRanMarker)).toBe(false);
  }, 60_000);

  test("a cluster node the replicated answer names as failed stops the deploy before Harper runs, naming the node and the remedy", async () => {
    reset({
      set_configuration: () => Response.json({
        message: "Configuration successfully set.",
        replicated: [{ node: "node-b", status: "failed", reason: "connection closed" }, { node: "node-c" }],
      }),
    });
    let thrown: Error | undefined;
    try { await deploy(base()); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain("the MQTT-off configuration did not reach node-b, so nothing was deployed");
    expect(thrown?.message).toContain('"operation":"set_configuration"');
    expect(thrown?.message).toContain("--keep-mqtt-config");
    expect(thrown?.message).not.toContain("node-c");
    expect(existsSync(harperRanMarker), "Harper ran after a failed node").toBe(false);
    expect(ops()).toEqual(["set_configuration"]);
  }, 60_000);

  test("--keep-mqtt-config leaves the target's MQTT configuration as it is, before and after", async () => {
    reset();
    await deploy(base({ keepMqttConfig: true }));
    expect(received).toEqual([]);
    expect(existsSync(harperRanMarker), "Harper deployed").toBe(true);
  }, 60_000);

  test("--dry-run sends nothing", async () => {
    reset();
    await deploy(base({ dryRun: true }));
    expect(received).toEqual([]);
  }, 60_000);
});

describe("step 2: after the deploy's restart, deploy() checks the MQTT listeners are off", () => {
  test("a shared application: the configuration is read and MQTT over WebSocket is checked at the target URL; no extra restart", async () => {
    reset();
    const probed: string[] = [];
    await deploy(base({ mqttProbe: async (url) => { probed.push(url); return OFF; } }));
    expect(ops()).toEqual(["set_configuration", "get_configuration"]);
    expect(received[1].harperHadRun, "the configuration was read after Harper deployed").toBe(true);
    expect(probed).toEqual([target]);
  }, 60_000);

  test("an isolated application: the shared worker threads are restarted (pool scope, replicated), the job is awaited, then MQTT over WebSocket is checked", async () => {
    reset({ get_configuration: () => Response.json({ mqtt: MQTT_OFF, flair: { isolated: true } }) });
    let probesAfterRestart = 0;
    await deploy(base({ mqttProbe: async () => { if (ops().includes("restart_service")) probesAfterRestart++; return OFF; } }));
    expect(ops()).toEqual(["set_configuration", "get_configuration", "restart_service", "get_job"]);
    expect(received[2].body).toEqual({ operation: "restart_service", service: "http_workers", scope: "", replicated: true });
    expect(received[3].body).toEqual({ operation: "get_job", id: "job-1" });
    expect(probesAfterRestart, "MQTT over WebSocket was checked after the restart").toBe(1);
  }, 60_000);

  test("a standalone isolated instance: the restart job answers that there is no replication, and the shared workers are restarted on their own", async () => {
    reset({
      get_configuration: () => Response.json({ mqtt: MQTT_OFF, "my-flair": { isolated: true } }),
      restart_service: (body) => Response.json({ message: "Restarting http_workers", job_id: body.replicated ? "job-r" : "job-1" }),
      get_job: (body) => body.id === "job-r"
        ? Response.json([{ id: "job-r", status: "ERROR", message: "Replication not implemented." }])
        : completedJob(body),
    });
    await deploy(base({ project: "my-flair" }));
    expect(received.filter((r) => r.body?.operation === "restart_service").map((r) => r.body)).toEqual([
      { operation: "restart_service", service: "http_workers", scope: "", replicated: true },
      { operation: "restart_service", service: "http_workers", scope: "" },
    ]);
  }, 60_000);

  test("MQTT over WebSocket still served after the deploy's restart: the shared workers are restarted once, and the deploy passes when it stops", async () => {
    reset();
    await deploy(base({ mqttProbe: async () => (ops().includes("restart_service") ? OFF : SERVED) }));
    expect(ops()).toEqual(["set_configuration", "get_configuration", "restart_service", "get_job"]);
  }, 60_000);

  test("MQTT over WebSocket still served after the shared workers were restarted: the deploy fails, naming the restart to run", async () => {
    reset();
    let thrown: Error | undefined;
    try { await deploy(base({ mqttProbe: async () => SERVED })); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain(`${target} still serves MQTT over WebSocket after the shared worker threads were restarted`);
    expect(thrown?.message).toContain('{"operation":"restart_service","service":"http_workers","scope":""}');
    expect(thrown?.message).toContain(opsUrl);
    expect(thrown?.message).toContain("get_configuration");
    expect(ops().filter((o) => o === "restart_service").length).toBe(1);
  }, 60_000);

  test("a configuration that still starts an MQTT listener fails the deploy by name", async () => {
    reset({ get_configuration: () => Response.json({ mqtt: { ...MQTT_OFF, webSocket: true } }) });
    await expect(deploy(base())).rejects.toThrow(/does not show the MQTT-off values that were set: mqtt.webSocket is true/);
  }, 60_000);

  test("a configuration that cannot be read fails the deploy by name", async () => {
    reset({ get_configuration: () => new Response("no", { status: 403 }) });
    await expect(deploy(base())).rejects.toThrow(/could not read the configuration of .* to check that its MQTT listeners are off \(HTTP 403/);
  }, 60_000);

  test("a restart job that fails fails the deploy by name", async () => {
    reset({
      get_configuration: () => Response.json({ mqtt: MQTT_OFF, flair: { isolated: true } }),
      get_job: () => Response.json([{ id: "job-1", status: "ERROR", message: "worker did not start" }]),
    });
    let thrown: Error | undefined;
    try { await deploy(base()); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toMatch(/restarting the shared worker threads of .* failed \(the job ended ERROR\)/);
    expect(thrown?.message).not.toContain("worker did not start"); // the job's text is never printed
  }, 60_000);

  test("--no-verify skips the check and says what to run; --no-restart skips it and says the setting applies at the next restart", async () => {
    reset();
    const warn = captureWarn();
    try {
      await deploy(base({ mqttCheck: undefined, verify: false }));
      await deploy(base({ restart: false }));
    } finally {
      warn.restore();
    }
    expect(ops()).toEqual(["set_configuration", "set_configuration"]);
    const text = warn.lines.join("\n");
    expect(text).toContain("the MQTT listener check did not run (--no-verify)");
    expect(text).toContain("--no-restart: the MQTT-off configuration takes effect when the target's worker threads restart");
    expect(text).toContain('"operation":"restart_service"');
  }, 60_000);
});

describe("step 2 fails unless every restart and the check are proven", () => {
  const isolatedConfig = () => Response.json({ mqtt: MQTT_OFF, flair: { isolated: true } });

  test("a restart answered without a job id fails the deploy by name", async () => {
    reset({ get_configuration: isolatedConfig, restart_service: () => Response.json({ message: "Restarting http_workers" }) });
    await expect(deploy(base())).rejects.toThrow(/failed \(the restart was answered without a job id/);
    expect(ops()).not.toContain("get_job");
  }, 60_000);

  test("a replicated restart job that completes but records a node it could not restart (Harper's coded shape) fails the deploy, naming the node", async () => {
    reset({
      get_configuration: isolatedConfig,
      get_job: (body) => completedJob(body, [
        { node: "node-b", message: "Successfully completed job: peer-1" },
        { node: "node-c", message: "connect ECONNREFUSED 10.0.0.3:9925" },
      ]),
    });
    let thrown: Error | undefined;
    try { await deploy(base()); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain("the job records these nodes without a completed restart: node-c");
    expect(thrown?.message).not.toContain("node-b,");
    expect(thrown?.message).not.toContain("ECONNREFUSED"); // the node's error text is never printed
    expect(thrown?.message).toContain('"operation":"restart_service"');
  }, 60_000);

  test("a replicated restart job that completes without listing its nodes fails the deploy", async () => {
    reset({
      get_configuration: isolatedConfig,
      get_job: (body) => Response.json([{ id: body.id, status: "COMPLETE", message: `Successfully completed job: ${body.id}` }]),
    });
    await expect(deploy(base())).rejects.toThrow(/the replicated job's result lists no cluster nodes/);
  }, 60_000);

  test("a restart job that completes with something other than a completed restart fails the deploy", async () => {
    reset({
      get_configuration: isolatedConfig,
      get_job: (body) => Response.json([{ id: body.id, status: "COMPLETE", message: "Unrecognized service: http_workers" }]),
    });
    let thrown: Error | undefined;
    try { await deploy(base({ replicated: false })); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain("the job completed with a message other than Harper's completed-job message");
    expect(thrown?.message).not.toContain("Unrecognized service");
  }, 60_000);

  test("an inconclusive WebSocket check (no off answer before the deadline) fails the deploy, naming the restart and check to run", async () => {
    reset();
    let thrown: Error | undefined;
    try { await deploy(base({ mqttProbe: async () => INCONCLUSIVE })); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain(`could not confirm that ${target} no longer serves MQTT over WebSocket (test: no answer)`);
    expect(thrown?.message).toContain('"operation":"restart_service"');
    expect(thrown?.message).toContain("get_configuration");
    expect(ops()).not.toContain("restart_service"); // an inconclusive check is not taken for "served"
  }, 60_000);

  test("an inconclusive check that turns into the off answer within the deadline passes", async () => {
    reset();
    let calls = 0;
    await deploy(base({ mqttCheckTimeoutMs: 10_000, mqttProbe: async () => (++calls < 2 ? INCONCLUSIVE : OFF) }));
    expect(calls).toBe(2);
  }, 60_000);

  test("an empty or malformed configuration answer fails the deploy (it is not taken for MQTT off)", async () => {
    for (const [answer, why] of [
      [{}, "the answer has no mqtt section"],
      [[], "the answer is not a configuration object"],
      [{ mqtt: { webSocket: false } }, "mqtt.network is missing"],
      [{ mqtt: { webSocket: false, network: { port: null } } }, "mqtt.network.securePort is undefined"],
    ] as const) {
      reset({ get_configuration: () => Response.json(answer) });
      await expect(deploy(base()), JSON.stringify(answer)).rejects.toThrow(why);
    }
  }, 60_000);

  test("the WebSocket check reaches --mqtt-check-url when given", async () => {
    reset();
    const probed: string[] = [];
    await deploy(base({ mqttCheckUrl: "https://flair.example.invalid", mqttProbe: async (url) => { probed.push(url); return OFF; } }));
    expect(probed).toEqual(["https://flair.example.invalid"]);
  }, 60_000);
});

describe("only the node the target URL reaches is verified; every other cluster node is NOT VERIFIED", () => {
  /** A replicated set_configuration answer naming two peer nodes that took the setting. */
  const replicatedAnswer = () => Response.json({
    message: "Configuration successfully set.",
    replicated: [{ node: "node-b", message: "Configuration successfully set." }, { node: "node-c", message: "Configuration successfully set." }],
  });

  test("the peers the replicated configuration names are reported NOT VERIFIED by name, with the check and restart to run on each; the deploy succeeds", async () => {
    reset({ set_configuration: replicatedAnswer });
    const warn = captureWarn();
    try { await deploy(base()); } finally { warn.restore(); }
    const text = warn.lines.join("\n");
    for (const node of ["node-b", "node-c"]) {
      expect(text).toContain(`NOT VERIFIED: cluster node ${node}.`);
      expect(text).toContain(`on ${node}, run flair doctor (its "MQTT listeners" section reports the listener state)`);
      expect(text).toContain(`to http://${node}:${new URL(opsUrl).port} (Basic admin credential)`);
    }
    expect(text).toContain("a completed restart job is not proof of a peer's restart");
    expect(text).toContain('"operation":"restart_service"');
    expect(text).toContain("--require-all-nodes-verified");
  }, 60_000);

  test("the nodes an isolated application's restart job names are reported too", async () => {
    reset({
      set_configuration: () => Response.json({ message: "ok", replicated: [{ node: "node-b", message: "ok" }] }),
      get_configuration: () => Response.json({ mqtt: MQTT_OFF, flair: { isolated: true } }),
      get_job: (body) => completedJob(body, [
        { node: "node-b", message: "Successfully completed job: peer-1" },
        { node: "node-d", message: "Successfully completed job: peer-2" },
      ]),
    });
    const warn = captureWarn();
    try { await deploy(base()); } finally { warn.restore(); }
    const lines = warn.lines.filter((l) => l.includes("NOT VERIFIED"));
    expect(lines.map((l) => /cluster node (\S+)\./.exec(l)?.[1]).sort()).toEqual(["node-b", "node-d"]);
  }, 60_000);

  test("--require-all-nodes-verified fails the deploy when a peer is not verified, naming each and what to run", async () => {
    reset({ set_configuration: replicatedAnswer });
    let thrown: Error | undefined;
    try { await deploy(base({ requireAllNodesVerified: true })); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain("--require-all-nodes-verified: 2 cluster nodes were NOT VERIFIED: node-b, node-c");
    expect(thrown?.message).toContain("a completed restart job is not proof of a peer's restart");
    expect(thrown?.message).toContain("on node-b, run flair doctor");
  }, 60_000);

  test("a standalone target (no cluster nodes) is fully verified, with or without --require-all-nodes-verified", async () => {
    reset();
    const warn = captureWarn();
    try { await deploy(base({ requireAllNodesVerified: true })); } finally { warn.restore(); }
    expect(warn.lines.join("\n")).not.toContain("NOT VERIFIED");
  }, 60_000);
});

describe("operations API URLs carry no credential and are printed redacted", () => {
  test("an operations URL with a user name and password is refused before any request, and the password is never printed", async () => {
    reset();
    const ops = new URL(opsUrl);
    ops.username = "ops-user";
    ops.password = "not-a-real-secret";
    let thrown: Error | undefined;
    try { await deploy(base({ opsUrl: ops.toString() })); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain("carries a user name or password. Nothing was sent.");
    expect(thrown?.message).not.toContain("not-a-real-secret");
    expect(thrown?.message).not.toContain("ops-user");
    expect(received).toEqual([]);
    expect(existsSync(harperRanMarker)).toBe(false);
  }, 60_000);

  test("an operations URL with any query or fragment is refused before any request, and the value is never printed", async () => {
    for (const suffix of ["/?access_token=not-a-real-token", "/?region=not-a-real-token", "/#not-a-real-token"]) {
      reset();
      let thrown: Error | undefined;
      try { await deploy(base({ opsUrl: `${opsUrl}${suffix}` })); } catch (err) { thrown = err as Error; }
      expect([suffix, thrown?.message.includes("Nothing was sent")]).toEqual([suffix, true]);
      expect(thrown?.message).toMatch(/it carries a (query|fragment)/);
      expect(thrown?.message).not.toContain("not-a-real-token");
      expect(received).toEqual([]);
    }
  }, 60_000);

  test("a deploy target or MQTT check URL with a user name, password, query or fragment is refused before anything is sent", async () => {
    for (const over of [
      { target: "https://deploy-user:not-a-real-secret@flair.example.invalid" },
      { target: "https://flair.example.invalid/?token=not-a-real-secret" },
      { mqttCheckUrl: "https://flair.example.invalid/#not-a-real-secret" },
    ] as Partial<DeployOptions>[]) {
      reset();
      const progress: string[] = [];
      let thrown: Error | undefined;
      try { await deploy(base({ ...over, opsUrl, onProgress: (m) => progress.push(m) })); } catch (err) { thrown = err as Error; }
      expect([JSON.stringify(over), thrown?.message.includes("cannot be used")]).toEqual([JSON.stringify(over), true]);
      expect(thrown?.message).not.toContain("not-a-real-secret");
      expect(thrown?.message).not.toContain("deploy-user");
      expect(progress).toEqual([]);
      expect(received).toEqual([]);
      expect(existsSync(harperRanMarker)).toBe(false);
    }
  }, 60_000);

  test("an error answer's body is never printed, even when it echoes a value", async () => {
    const echoing = () => new Response(JSON.stringify({ error: "bad request for region=private-value" }), { status: 400 });
    for (const over of [
      { set_configuration: echoing },
      { get_configuration: echoing },
      { get_configuration: () => Response.json({ mqtt: MQTT_OFF, flair: { isolated: true } }), restart_service: echoing },
    ] as Record<string, Handler>[]) {
      reset(over);
      const progress: string[] = [];
      const warn = captureWarn();
      let thrown: Error | undefined;
      try { await deploy(base({ onProgress: (m) => progress.push(m) })); } catch (err) { thrown = err as Error; } finally { warn.restore(); }
      expect([Object.keys(over).join(","), thrown?.message.includes("HTTP 400")]).toEqual([Object.keys(over).join(","), true]);
      expect([thrown?.message ?? "", ...progress, ...warn.lines].join("\n")).not.toContain("private-value");
    }
  }, 60_000);

});

