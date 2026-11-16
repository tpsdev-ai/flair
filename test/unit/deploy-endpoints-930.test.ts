/**
 * flair#930 — deploy_component goes to the operations endpoint; migration,
 * discovery, and verification go to the application endpoint. With neither
 * explicit endpoint set, both stay the single target URL.
 *
 * Each mock answers only its own routes: the operations mock rejects
 * application probes, and the application mock rejects deploy_component.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy, REQUIRED_PACKAGE_FILES, verifyDeployServing, type DeployOptions } from "../../src/deploy.ts";
import { DEFAULT_HARPER_PIN, fabricUpgrade, type FabricUpgradeDeps } from "../../src/fabric-upgrade.ts";
import { buildFabricUpgradeOptions } from "../../src/commands/upgrade.ts";
import { resolveEffectiveOpsUrl } from "../../src/cli.ts";

const FAST = { verifyPollIntervalMs: 1, verifySettleStreak: 1, verifyTimeoutMs: 2000 };
const FIXTURE = join(import.meta.dir, "..", "fixtures", "deploy-version-probe-930.ts");
const SUCCESS_TEXT = /UPGRADE_COMPLETE|✓|upgrade complete|verified serving|already up to date|check complete/;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function packageRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-930-pkg-"));
  roots.push(dir);
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
      files: ["dist/", "schemas/", "config.yaml"],
    }),
  );
  const binDir = join(dir, "node_modules", "harper", "dist", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "harper.js"),
    [
      'const targetArg = process.argv.find((a) => a.startsWith("target="));',
      "if (!targetArg) process.exit(2);",
      'const url = targetArg.slice("target=".length).replace(/\\/$/, "") + "/";',
      "fetch(url, {",
      '  method: "POST",',
      '  headers: { "content-type": "application/json" },',
      '  body: JSON.stringify({ operation: "deploy_component" }),',
      "}).then((res) => process.exit(res.status >= 200 && res.status < 300 ? 0 : 1)).catch(() => process.exit(1));",
      "",
    ].join("\n"),
  );
  return dir;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function appBody(url: URL): Response {
  if (url.pathname === "/HealthDetail") {
    return json({
      memories: { modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 599 } },
      migrations: { cyclePhase: "done", migrations: [{ id: "embedding-stamp", state: "completed", rowsRemaining: 0 }] },
    });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json({ issuer: url.origin, token_endpoint: `${url.origin}/oauth/mcp/token` });
  }
  if (url.pathname === "/OAuthMetadata") return json({ issuer: url.origin });
  if (url.pathname === "/Memory") return json([]);
  if (url.pathname === "/Health") return json({ version: "9.9.9-test" });
  return json({});
}

type Role = "both" | "ops" | "app";

function startMock(role: Role): { url: string; hits: string[]; stop: () => void } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let operation = "";
      if (req.method === "POST") {
        const text = await req.text();
        try {
          operation = String(JSON.parse(text).operation ?? "");
        } catch {
          operation = "";
        }
      }
      hits.push(req.method === "POST" ? `POST ${operation || url.pathname}` : `GET ${url.pathname}`);
      if (req.method === "POST") {
        if (operation === "deploy_component" && role !== "app") return json({ ok: true });
        return new Response("deploy refused", { status: 404 });
      }
      const appRoute =
        url.pathname === "/Memory" ||
        url.pathname === "/Health" ||
        url.pathname === "/HealthDetail" ||
        url.pathname === "/OAuthMetadata" ||
        url.pathname.startsWith("/.well-known/");
      if (role === "ops" && appRoute) return new Response("app route refused", { status: 404 });
      return appBody(url);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

function deployOpts(over: DeployOptions): DeployOptions {
  return {
    fabricUser: "admin",
    fabricPassword: "pw",
    packageRoot: packageRoot(),
    keepMqttConfig: true,
    harperRuntime: process.execPath,
    ...FAST,
    ...over,
  };
}

function plantDeps(over: Partial<FabricUpgradeDeps> = {}): FabricUpgradeDeps {
  return {
    fetchLatestFlairVersion: async () => "0.14.0",
    fetchDeclaredHarperVersion: async () => "5.0.21",
    npmInstall: (dir: string) => {
      const harperDir = join(dir, "node_modules", "harper");
      mkdirSync(harperDir, { recursive: true });
      writeFileSync(join(harperDir, "package.json"), JSON.stringify({ name: "harper", version: DEFAULT_HARPER_PIN }));
      const flairDir = join(dir, "node_modules", "@tpsdev-ai", "flair");
      mkdirSync(flairDir, { recursive: true });
      writeFileSync(join(flairDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.14.0", files: ["dist"] }));
    },
    fetchDeployedVersion: async () => "0.13.0",
    deploy: async (opts) => ({
      url: opts.target ?? "",
      project: opts.project ?? "flair",
      version: opts.version ?? "0.14.0",
      packageRoot: opts.packageRoot ?? "",
      dryRun: false,
    }),
    log: () => {},
    ...over,
  };
}

describe("flair#930 endpoints", () => {
  test("the single target URL receives both deploy_component and application probes", async () => {
    const mock = startMock("both");
    try {
      const result = await deploy(deployOpts({ target: mock.url }));
      expect(result.url).toBe(mock.url);
      expect(mock.hits).toContain("POST deploy_component");
      expect(mock.hits).toContain("GET /Memory");
      expect(mock.hits).toContain("GET /HealthDetail");
      expect(mock.hits).toContain("GET /.well-known/oauth-authorization-server");
    } finally {
      mock.stop();
    }
  });

  test("operations and application endpoints reject each other's requests and the deploy uses each for its own calls", async () => {
    const ops = startMock("ops");
    const app = startMock("app");
    try {
      const result = await deploy(deployOpts({
        target: app.url,
        operationsEndpoint: ops.url,
        applicationEndpoint: app.url,
      }));
      expect(result.url).toBe(app.url);
      expect(ops.hits).toContain("POST deploy_component");
      expect(app.hits).not.toContain("POST deploy_component");
      expect(app.hits).toContain("GET /Memory");
      expect(app.hits).toContain("GET /HealthDetail");
      expect(app.hits).toContain("GET /.well-known/oauth-authorization-server");
      expect(ops.hits).not.toContain("GET /Memory");
      expect(ops.hits).not.toContain("GET /HealthDetail");
      expect(ops.hits).not.toContain("GET /.well-known/oauth-authorization-server");
    } finally {
      ops.stop();
      app.stop();
    }
  });

  test("HTTP 404 on the single target does not claim a wrong package root", async () => {
    const mock = startMock("ops");
    try {
      const err = await deploy(deployOpts({ target: mock.url })).then(() => {
        throw new Error("expected the 404 probe to fail");
      }, (e: Error) => e);
      expect(err.message).toContain(`GET ${mock.url}/Memory returned 404`);
      expect(err.message).toContain("--application-endpoint");
      expect(err.message).not.toMatch(/wrong package root|component is not serving|\babsent\b|not found/);
    } finally {
      mock.stop();
    }
  });
});

describe("flair#930 resource probe fails closed", () => {
  const base = "https://app.example";
  const probe = { baseUrl: base, resources: ["Memory"], pollIntervalMs: 1, settleStreak: 1, timeoutMs: 2000 };

  function fetchStatus(status: number, body: string): typeof fetch {
    return (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.endsWith("/Memory")) return new Response(body, { status });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("a 200 with an empty body is refused", async () => {
    const err = await verifyDeployServing({ ...probe, fetchImpl: fetchStatus(200, "") }).then(() => {
      throw new Error("empty body was accepted");
    }, (e: Error) => e);
    expect(err.message).toContain("empty body");
    expect(err.message).toContain("--application-endpoint");
    expect(err.message).not.toMatch(/\babsent\b|\bok\b|not found|wrong package root/);
  });

  test("a 200 with a non-JSON body is refused", async () => {
    await expect(verifyDeployServing({ ...probe, fetchImpl: fetchStatus(200, "<html>nope</html>") })).rejects.toThrow(/not JSON/);
  });

  test("a 200 whose row list has a non-object entry is refused", async () => {
    const err = await verifyDeployServing({ ...probe, fetchImpl: fetchStatus(200, "[1]") }).then(() => {
      throw new Error("unparsed row was accepted");
    }, (e: Error) => e);
    expect(err.message).toContain("entry 0 is not an object");
    expect(err.message).not.toMatch(/\babsent\b|\bok\b|not found|wrong package root/);
  });

  test("a failed request is refused", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.endsWith("/Memory")) throw new Error("connect ECONNREFUSED");
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(verifyDeployServing({ ...probe, fetchImpl })).rejects.toThrow(/request to https:\/\/app\.example\/Memory failed/);
  });

  test("401 and a JSON array still count as the route responding", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return new Response("[]", { status: 200 });
      return new Response("", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(verifyDeployServing({ ...probe, resources: ["Memory"], fetchImpl })).resolves.toBeUndefined();
  });
});

describe("flair#930 version probe fails closed before deploy", () => {
  function recording(): { deps: Partial<FabricUpgradeDeps>; calls: { deploy: number; npm: number; logs: string[] } } {
    const calls = { deploy: 0, npm: 0, logs: [] as string[] };
    const deps: Partial<FabricUpgradeDeps> = {
      fetchLatestFlairVersion: async () => "9.9.9",
      fetchDeclaredHarperVersion: async () => "5.3.1",
      npmInstall: () => { calls.npm++; },
      deploy: async () => {
        calls.deploy++;
        return { url: "http://unused.example", project: "flair", version: "9.9.9", packageRoot: "", dryRun: false };
      },
      log: (m) => calls.logs.push(m),
    };
    return { deps, calls };
  }

  async function probe(body: () => Response): Promise<{ message: string; calls: { deploy: number; npm: number; logs: string[] } }> {
    const server = Bun.serve({ port: 0, fetch: () => body() });
    const rec = recording();
    try {
      const err = await fabricUpgrade(
        { target: `http://127.0.0.1:${server.port}`, fabricUser: "admin", fabricPassword: "pw" },
        rec.deps,
      ).then(() => {
        throw new Error("version probe was treated as success");
      }, (e: Error) => e);
      return { message: err.message, calls: rec.calls };
    } finally {
      server.stop(true);
    }
  }

  test("an empty /Health body writes nothing and is not success", async () => {
    const result = await probe(() => new Response("", { status: 200 }));
    expect(result.message).toContain("the body was empty");
    expect(result.message).toContain("--application-endpoint");
    expect(result.message).not.toMatch(/\babsent\b|\bok\b|not found/);
    expect(result.calls.deploy).toBe(0);
    expect(result.calls.npm).toBe(0);
    expect(result.calls.logs.join("\n")).not.toMatch(SUCCESS_TEXT);
  });

  test("a non-JSON /Health body writes nothing", async () => {
    const result = await probe(() => new Response("not-json", { status: 200 }));
    expect(result.message).toContain("not JSON");
    expect(result.calls.deploy).toBe(0);
    expect(result.calls.npm).toBe(0);
  });

  test("a failed /Health request writes nothing", async () => {
    const rec = recording();
    const err = await fabricUpgrade(
      { target: "http://127.0.0.1:1", fabricUser: "admin", fabricPassword: "pw" },
      rec.deps,
    ).then(() => {
      throw new Error("failed probe was treated as success");
    }, (e: Error) => e);
    expect(err.message).toContain("the request failed");
    expect(rec.calls.deploy).toBe(0);
    expect(rec.calls.npm).toBe(0);
    expect(rec.calls.logs.join("\n")).not.toMatch(SUCCESS_TEXT);
  });

  test("empty /Health exits nonzero, writes nothing, and prints no success text", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 200 }) });
    const work = mkdtempSync(join(tmpdir(), "flair-930-work-"));
    const scratch = mkdtempSync(join(tmpdir(), "flair-930-tmp-"));
    roots.push(work, scratch);
    try {
      // Async spawn: Bun.serve answers on this event loop, so a blocking
      // spawn would stall the server until the child's own fetch timed out.
      const proc = Bun.spawn(["bun", FIXTURE], {
        cwd: work,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PROBE_URL: `http://127.0.0.1:${server.port}`,
          WORK_DIR: work,
          TMPDIR: scratch,
          HOME: work,
        },
      });
      const kill = setTimeout(() => proc.kill(), 20_000);
      const [stdout, stderr, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(kill);
      const output = `${stdout}${stderr}`;
      expect(status, output).not.toBe(0);
      expect(output).toContain("the body was empty");
      expect(output).toContain("--application-endpoint");
      expect(output).not.toMatch(SUCCESS_TEXT);
      expect(existsSync(join(work, "npm-install"))).toBe(false);
      expect(existsSync(join(work, "deploy"))).toBe(false);
      expect(readdirSync(scratch).some((name) => name.startsWith("flair-fabric-upgrade-") || name.startsWith("flair-deploy-"))).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 60_000);
});

describe("flair#930 upgrade wiring", () => {
  test("fabricUpgrade reads the version from the application endpoint and passes both endpoints to deploy()", async () => {
    const seen: string[] = [];
    const deploys: DeployOptions[] = [];
    const logs: string[] = [];
    await fabricUpgrade(
      {
        target: "https://single.example",
        operationsEndpoint: "https://ops.example:9925",
        applicationEndpoint: "https://app.example:9926",
        fabricUser: "admin",
        fabricPassword: "pw",
      },
      plantDeps({
        fetchDeployedVersion: async (o) => {
          seen.push(o.url);
          return "0.13.0";
        },
        deploy: async (opts) => {
          deploys.push(opts);
          return { url: opts.applicationEndpoint ?? opts.target ?? "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false };
        },
        log: (m) => logs.push(m),
      }),
    );
    expect(seen).toEqual(["https://app.example:9926", "https://app.example:9926"]);
    expect(deploys[0].target).toBe("https://single.example");
    expect(deploys[0].operationsEndpoint).toBe("https://ops.example:9925");
    expect(deploys[0].applicationEndpoint).toBe("https://app.example:9926");
    expect(logs.join("\n")).toContain("Deploying flair 0.14.0 to https://ops.example:9925");
  });

  test("fabricUpgrade without the new options keeps the single target for the version probe and deploy()", async () => {
    const seen: string[] = [];
    const deploys: DeployOptions[] = [];
    await fabricUpgrade(
      { target: "https://single.example", fabricUser: "admin", fabricPassword: "pw" },
      plantDeps({
        fetchDeployedVersion: async (o) => {
          seen.push(o.url);
          return "0.13.0";
        },
        deploy: async (opts) => {
          deploys.push(opts);
          return { url: opts.target ?? "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false };
        },
      }),
    );
    expect(seen).toEqual(["https://single.example", "https://single.example"]);
    expect(deploys[0].operationsEndpoint).toBeUndefined();
    expect(deploys[0].applicationEndpoint).toBeUndefined();
    expect(deploys[0].target).toBe("https://single.example");
  });

  test("buildFabricUpgradeOptions carries the endpoints and sends MQTT to the operations endpoint only when --ops-target is unset", () => {
    const prior = process.env.FLAIR_OPS_TARGET;
    delete process.env.FLAIR_OPS_TARGET;
    try {
      const split = buildFabricUpgradeOptions(
        {
          target: "https://app.example:9926",
          operationsEndpoint: "https://ops.example:9925/",
          applicationEndpoint: "https://app.example:9926",
        },
        { fabricUser: "admin", fabricPassword: "pw" },
        resolveEffectiveOpsUrl,
      );
      expect(split.operationsEndpoint).toBe("https://ops.example:9925/");
      expect(split.applicationEndpoint).toBe("https://app.example:9926");
      expect(split.opsUrl).toBe("https://ops.example:9925");

      const opsWins = buildFabricUpgradeOptions(
        {
          target: "https://app.example:9926",
          operationsEndpoint: "https://ops.example:9925",
          opsTarget: "https://mqtt.example:9925",
        },
        { fabricUser: "admin", fabricPassword: "pw" },
        resolveEffectiveOpsUrl,
      );
      expect(opsWins.opsUrl).toBe("https://mqtt.example:9925");

      const single = buildFabricUpgradeOptions(
        { target: "https://app.example" },
        { fabricUser: "admin", fabricPassword: "pw" },
        resolveEffectiveOpsUrl,
      );
      expect(single.operationsEndpoint).toBeUndefined();
      expect(single.applicationEndpoint).toBeUndefined();
      expect(single.opsUrl).toBe("https://app.example:9925");
    } finally {
      if (prior === undefined) delete process.env.FLAIR_OPS_TARGET;
      else process.env.FLAIR_OPS_TARGET = prior;
    }
  });
});
