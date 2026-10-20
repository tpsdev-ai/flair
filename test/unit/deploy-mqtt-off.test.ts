/**
 * deploy-mqtt-off.test.ts — `flair deploy` / `flair upgrade --target` set the
 * target's MQTT listeners off in its configuration, request the restart that
 * applies it, and report what they set and requested (src/mqtt-off-deploy.ts).
 *
 * Flair runs Harper with MQTT off. A component deployment does not go through
 * flair's local spawns, and a component's config.yaml cannot set the
 * instance's `mqtt` section, so deploy():
 *   1. sends the MQTT-off configuration to the target's operations API
 *      (`set_configuration`) before anything is deployed — a refusal, or a
 *      cluster node the answer names as failed, stops it there;
 *   2. after the deploy's restart, reads the target's configuration back — an
 *      answer that is not a recognizable root configuration is not confirmed,
 *      and the saved `mqtt` section must read off (mismatches by field name and
 *      category) — and, when the application is isolated, requests the shared
 *      worker threads' restart and follows Harper's job, failing on any node the
 *      job names as failed; then it reports exactly what was set and requested,
 *      and that flair does not probe the listeners.
 * Every URL is http or https with a host, and scheme, host, port and path
 * only: anything else is refused before anything is sent. A redirect from the
 * operations API is not followed. Errors quote a remote's HTTP status, never
 * its body, a job's message, a configuration value or a transport error's
 * text.
 *
 * The whole deploy() path runs here against a REAL HTTP server standing in for
 * the target's operations API (the HTTP boundary), with a stub Harper binary
 * that records when it ran, so the CALLS in deploy() are what is under test.
 * test/integration/mqtt-off-isolated-deploy.test.ts drives Harper's own
 * deploy_component of an isolated component against a real Harper, and
 * test/integration/mqtt-off-fabric-upgrade.test.ts runs `fabricUpgrade()`
 * into this deploy() against a real Harper.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy, REQUIRED_PACKAGE_FILES } from "../../src/deploy.ts";
import { MQTT_DISABLED_SET_CONFIGURATION } from "../../src/lib/mqtt-config.ts";
import type { DeployOptions } from "../../src/deploy.ts";
import { MQTT_OFF_REPORT_LIMIT } from "../../src/mqtt-off-deploy.ts";

interface Received {
  body: any;
  authorization: string | null;
  /** Whether the stub Harper had already run when this request arrived. */
  harperHadRun: boolean;
}

let server: ReturnType<typeof Bun.serve>;
/** The operations API stand-in. */
let opsUrl: string;
/** Its host and port, as the report names it. */
let opsHost: string;
/** The deploy target whose operations API is derived as `opsUrl` (port + 1, flair's port-1 convention). */
let target: string;
let received: Received[] = [];
type Handler = (body: any) => Response;
let handlers: Record<string, Handler> = {};
let harperRanMarker = "";
const temps: string[] = [];

const MQTT_OFF = { network: { port: null, securePort: null, mtls: false }, webSocket: false, requireAuthentication: true };
/** A get_configuration answer: a root configuration with MQTT off, and `extra`. */
const rootConfig = (extra: Record<string, unknown> = {}) => ({ http: { port: 9926 }, operationsApi: { network: { port: 9925 } }, rootPath: "/hdb", mqtt: MQTT_OFF, ...extra });
/** Harper's completed restart job: its own message, and for a replicated restart each node's (bin/restart.ts). */
const completedJob = (body: any, nodes: unknown[] = [{ node: "node-b", message: "Successfully completed job: peer-job-1" }]) =>
  Response.json([{ id: body.id, status: "COMPLETE", message: `Successfully completed job: ${body.id}`, ...(lastRestartWasReplicated ? { result: { replicated: nodes } } : {}) }]);
let lastRestartWasReplicated = false;
const defaults = (): Record<string, Handler> => ({
  set_configuration: () => Response.json({ message: "Configuration successfully set." }),
  get_configuration: () => Response.json(rootConfig()),
  restart_service: (body) => { lastRestartWasReplicated = body.replicated === true; return Response.json({ message: "Restarting http_workers", job_id: "job-1" }); },
  get_job: (body) => completedJob(body),
});

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
  opsHost = `127.0.0.1:${server.port}`;
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

/** The served-API verification is off; the post-restart MQTT step runs. */
function base(over: Partial<DeployOptions> = {}): DeployOptions {
  return {
    target,
    fabricUser: "deploy-admin",
    fabricPassword: "not-a-real-password",
    packageRoot: synthPkgRoot(),
    verify: false,
    mqttCheck: true,
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

  test("a cluster node the replicated answer names as failed stops the deploy before Harper runs, naming the node, its operations URL and the request to send", async () => {
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
    expect(thrown?.message).toContain(`to http://node-b:${server.port} and restart its worker threads`);
    expect(thrown?.message).toContain("--keep-mqtt-config");
    expect(thrown?.message).not.toContain("node-c");
    expect(thrown?.message).not.toContain("connection closed"); // a node's error text is never printed
    expect(existsSync(harperRanMarker), "Harper ran after a failed node").toBe(false);
    expect(ops()).toEqual(["set_configuration"]);
  }, 60_000);

  test("a failed node whose name is not a host name or address gets no URL built from it", async () => {
    reset({
      set_configuration: () => Response.json({ message: "ok", replicated: [{ node: "x@private-value/p?q", status: "failed" }] }),
    });
    let thrown: Error | undefined;
    try { await deploy(base()); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toContain("did not reach (a node whose name is not a host name or address)");
    expect(thrown?.message).toContain("to that node's operations API");
    expect(thrown?.message).not.toContain("private-value");
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

describe("step 2: after the deploy's restart, the saved configuration is read back and the restart requested", () => {
  test("a shared application: the configuration is read after Harper deployed, no extra restart is requested, and the report says exactly what was set and requested", async () => {
    reset();
    const progress: string[] = [];
    await deploy(base({ onProgress: (m) => progress.push(m) }));
    expect(ops()).toEqual(["set_configuration", "get_configuration"]);
    expect(received[1].harperHadRun, "the configuration was read after Harper deployed").toBe(true);
    expect(progress).toContain(
      `MQTT listeners configured off on ${opsHost}; shared workers restart requested (with the deploy's own restart); ` +
        `the saved configuration on ${opsHost} reads off. ${MQTT_OFF_REPORT_LIMIT}`,
    );
  }, 60_000);

  test("an isolated application: the shared worker threads' restart is requested (pool scope, replicated), the job is awaited, and the report names the job and each node's outcome", async () => {
    reset({
      set_configuration: () => Response.json({ message: "ok", replicated: [{ node: "node-b", message: "ok" }, { node: "node-c", message: "ok" }] }),
      get_configuration: () => Response.json(rootConfig({ flair: { isolated: true } })),
      get_job: (body) => completedJob(body, [
        { node: "node-b", message: "Successfully completed job: peer-1" },
        { node: "node-c", message: "Successfully completed job: peer-2" },
      ]),
    });
    const progress: string[] = [];
    await deploy(base({ onProgress: (m) => progress.push(m) }));
    expect(ops()).toEqual(["set_configuration", "get_configuration", "restart_service", "get_job"]);
    expect(received[2].body).toEqual({ operation: "restart_service", service: "http_workers", scope: "", replicated: true });
    expect(received[3].body).toEqual({ operation: "get_job", id: "job-1" });
    expect(progress).toContain(
      `MQTT listeners configured off on ${opsHost}, node-b, node-c; shared workers restart requested (job job-1: ${opsHost} completed, node-b completed, node-c completed); ` +
        `the saved configuration on ${opsHost} reads off. ${MQTT_OFF_REPORT_LIMIT}`,
    );
    // Nothing else is claimed.
    expect(progress.join("\n")).not.toMatch(/verified|is off on|listeners are off/i);
  }, 60_000);

  test("a standalone isolated instance: the restart job answers that there is no replication, and the shared workers' restart is requested on their own", async () => {
    reset({
      get_configuration: () => Response.json(rootConfig({ "my-flair": { isolated: true } })),
      restart_service: (body) => Response.json({ message: "Restarting http_workers", job_id: body.replicated ? "job-r" : "job-1" }),
      get_job: (body) => body.id === "job-r"
        ? Response.json([{ id: "job-r", status: "ERROR", message: "Replication not implemented." }])
        : completedJob(body),
    });
    const progress: string[] = [];
    await deploy(base({ project: "my-flair", onProgress: (m) => progress.push(m) }));
    expect(received.filter((r) => r.body?.operation === "restart_service").map((r) => r.body)).toEqual([
      { operation: "restart_service", service: "http_workers", scope: "", replicated: true },
      { operation: "restart_service", service: "http_workers", scope: "" },
    ]);
    expect(progress.join("\n")).toContain(`shared workers restart requested (job job-1: ${opsHost} completed)`);
  }, 60_000);

  test("a configuration that does not read off fails the deploy by field name and category", async () => {
    reset({ get_configuration: () => Response.json(rootConfig({ mqtt: { ...MQTT_OFF, webSocket: true } })) });
    await expect(deploy(base())).rejects.toThrow(/the saved configuration on .* does not read off: mqtt.webSocket is not false\./);
  }, 60_000);

  test("a successful configuration answer that echoes a value is reported by field name and category only, never the value", async () => {
    reset({
      get_configuration: () => Response.json(rootConfig({ mqtt: { webSocket: "private-value", network: { port: "private-value", securePort: "private-value" } } })),
    });
    const progress: string[] = [];
    const warn = captureWarn();
    let thrown: Error | undefined;
    try { await deploy(base({ onProgress: (m) => progress.push(m) })); } catch (err) { thrown = err as Error; } finally { warn.restore(); }
    expect(thrown?.message).toContain("mqtt.webSocket is not false, mqtt.network.port is not null, mqtt.network.securePort is not null");
    expect([thrown?.message ?? "", ...progress, ...warn.lines].join("\n")).not.toContain("private-value");
  }, 60_000);

  test("an answer that is not a recognizable root configuration is reported as not confirmed, never as off, even when its mqtt section reads off", async () => {
    for (const [answer, why] of [
      [{}, "it has no http, operationsApi, rootPath"],
      [[], "the answer is not an object"],
      [{ mqtt: MQTT_OFF }, "it has no http, operationsApi, rootPath"],
      [{ http: { port: 9926 }, mqtt: MQTT_OFF }, "it has no operationsApi, rootPath"],
      [{ error: "something" }, "it has no http, operationsApi, rootPath"],
    ] as const) {
      reset({ get_configuration: () => Response.json(answer) });
      const progress: string[] = [];
      let thrown: Error | undefined;
      try { await deploy(base({ onProgress: (m) => progress.push(m) })); } catch (err) { thrown = err as Error; }
      expect([JSON.stringify(answer), thrown?.message.includes(`is not a recognizable root configuration (${why}), so the MQTT-off configuration is not confirmed there`)]).toEqual([JSON.stringify(answer), true]);
      expect(progress.join("\n")).not.toContain("reads off");
    }
  }, 60_000);

  test("a configuration that cannot be read fails the deploy by name, as not confirmed", async () => {
    reset({ get_configuration: () => new Response("no", { status: 403 }) });
    await expect(deploy(base())).rejects.toThrow(/could not read the configuration of .* after the deploy \(HTTP 403\), so the MQTT-off configuration is not confirmed there/);
  }, 60_000);

  test("a redirect from the operations API is not followed: the read fails by its status and the location gets nothing", async () => {
    const elsewhere: string[] = [];
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { elsewhere.push(await req.text()); return Response.json(rootConfig()); } });
    try {
      reset({ get_configuration: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/` } }) });
      let thrown: Error | undefined;
      try { await deploy(base()); } catch (err) { thrown = err as Error; }
      expect(thrown?.message).toMatch(/could not read the configuration of .* \(HTTP 307\)/);
      expect(elsewhere).toEqual([]);
      reset({ set_configuration: () => new Response(null, { status: 308, headers: { location: `http://127.0.0.1:${other.port}/` } }) });
      thrown = undefined;
      try { await deploy(base()); } catch (err) { thrown = err as Error; }
      expect(thrown?.message).toMatch(/refused the MQTT-off configuration \(HTTP 308\), so nothing was deployed/);
      expect(elsewhere).toEqual([]);
      expect(existsSync(harperRanMarker)).toBe(false);
    } finally {
      other.stop(true);
    }
  }, 60_000);

  test("--no-restart skips step 2 and says the setting applies at the next restart; --no-verify skips it and says what was not done and what to send", async () => {
    reset();
    const warn = captureWarn();
    try {
      await deploy(base({ restart: false }));
      await deploy(base({ mqttCheck: undefined, verify: false }));
    } finally {
      warn.restore();
    }
    expect(ops()).toEqual(["set_configuration", "set_configuration"]);
    const text = warn.lines.join("\n");
    expect(text).toContain("--no-restart: the MQTT-off configuration takes effect when the target's worker threads restart");
    expect(text).toContain("the post-restart MQTT step did not run (--no-verify): the saved configuration was not read back");
    expect(text).toContain('"operation":"restart_service"');
  }, 60_000);
});

describe("step 2 fails on every failure Harper's restart job reports", () => {
  const isolatedConfig = () => Response.json(rootConfig({ flair: { isolated: true } }));

  test("a restart answered without a job id fails the deploy by name", async () => {
    reset({ get_configuration: isolatedConfig, restart_service: () => Response.json({ message: "Restarting http_workers" }) });
    await expect(deploy(base())).rejects.toThrow(/failed \(the restart was answered without a job id/);
    expect(ops()).not.toContain("get_job");
  }, 60_000);

  test("a restart job that fails fails the deploy by name, never printing its message", async () => {
    reset({
      get_configuration: isolatedConfig,
      get_job: () => Response.json([{ id: "job-1", status: "ERROR", message: "worker did not start" }]),
    });
    let thrown: Error | undefined;
    try { await deploy(base()); } catch (err) { thrown = err as Error; }
    expect(thrown?.message).toMatch(/the restart of the shared worker threads of .* failed \(the job ended ERROR\)/);
    expect(thrown?.message).not.toContain("worker did not start");
  }, 60_000);

  test("a replicated restart job that completes but records a node it could not restart fails the deploy, naming the node and its operations URL", async () => {
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
    expect(thrown?.message).toContain(`and the same request to http://node-c:${server.port}`);
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
    expect(thrown?.message).toContain("the job completed with a message other than Harper's completed-job message for this job");
    expect(thrown?.message).not.toContain("Unrecognized service");
  }, 60_000);

  test("a job status read that does not succeed is refused before its body is read, even when the body carries a completed job", async () => {
    for (const status of [500, 401, 404, 307]) {
      reset({
        get_configuration: isolatedConfig,
        get_job: (body) => new Response(JSON.stringify([{ id: body.id, status: "COMPLETE", message: `Successfully completed job: ${body.id}`, result: { replicated: [] } }]), {
          status,
          headers: { "content-type": "application/json", ...(status === 307 ? { location: "http://127.0.0.1:1/" } : {}) },
        }),
      });
      const progress: string[] = [];
      let thrown: Error | undefined;
      try { await deploy(base({ onProgress: (m) => progress.push(m) })); } catch (err) { thrown = err as Error; }
      expect([status, thrown?.message.includes(`failed (the job's status read was answered HTTP ${status})`)]).toEqual([status, true]);
      expect(progress.join("\n")).not.toContain("MQTT listeners configured off on");
    }
  }, 60_000);

  test("a completed job whose message is not exactly Harper's for the requested job fails the deploy", async () => {
    for (const message of ["Successfully completed job but restart failed", "Successfully completed job: job-1 but restart failed", "Successfully completed job: another-job"]) {
      reset({
        get_configuration: isolatedConfig,
        get_job: (body) => Response.json([{ id: body.id, status: "COMPLETE", message }]),
      });
      const progress: string[] = [];
      let thrown: Error | undefined;
      try { await deploy(base({ replicated: false, onProgress: (m) => progress.push(m) })); } catch (err) { thrown = err as Error; }
      expect([message, thrown?.message.includes("the job completed with a message other than Harper's completed-job message for this job")]).toEqual([message, true]);
      expect(progress.join("\n")).not.toContain("MQTT listeners configured off on");
    }
  }, 60_000);

  test("a job id that is not a plain token is not printed", async () => {
    reset({
      get_configuration: isolatedConfig,
      restart_service: (body) => { lastRestartWasReplicated = body.replicated === true; return Response.json({ job_id: "private-value <x>" }); },
    });
    const progress: string[] = [];
    await deploy(base({ onProgress: (m) => progress.push(m) }));
    const report = progress.find((m) => m.startsWith("MQTT listeners configured off"));
    expect(report).toContain("job (an id that is not a plain token):");
    expect(progress.join("\n")).not.toContain("private-value");
  }, 60_000);
});

describe("URLs carry no credential, need http or https with a host, and are printed redacted", () => {
  test("a URL without an allowed scheme or a host is refused before anything is sent, and its text is never printed", async () => {
    for (const over of [
      { target: "file:///tmp/private-value" },
      { target: "javascript:private-value" },
      { opsUrl: "file:///tmp/private-value" },
      { opsUrl: "javascript:private-value" },
      { opsUrl: "ws://flair.example.invalid:9925" },
    ] as Partial<DeployOptions>[]) {
      reset();
      const progress: string[] = [];
      let thrown: Error | undefined;
      try { await deploy(base({ opsUrl, ...over, onProgress: (m) => progress.push(m) })); } catch (err) { thrown = err as Error; }
      expect([JSON.stringify(over), thrown?.message.includes("Nothing was sent")]).toEqual([JSON.stringify(over), true]);
      expect(thrown?.message).toContain("its scheme is not http or https");
      expect(thrown?.message).not.toContain("private-value");
      expect(progress).toEqual([]);
      expect(received).toEqual([]);
      expect(existsSync(harperRanMarker)).toBe(false);
    }
  }, 60_000);

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

  test("a deploy target with a user name, password or query is refused before anything is sent", async () => {
    for (const over of [
      { target: "https://deploy-user:not-a-real-secret@flair.example.invalid" },
      { target: "https://flair.example.invalid/?token=not-a-real-secret" },
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
      { get_configuration: () => Response.json(rootConfig({ flair: { isolated: true } })), restart_service: echoing },
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
