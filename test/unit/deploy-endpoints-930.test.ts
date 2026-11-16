/**
 * flair#930 — deploy_component goes to the operations endpoint; migration,
 * discovery, and verification go to the application endpoint. With neither
 * explicit endpoint set, both stay the single target URL.
 *
 * Each mock answers only its own routes: the operations mock rejects
 * application probes, and the application mock rejects deploy_component.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deploy, REQUIRED_PACKAGE_FILES, resourceVerificationSkip, verifyDeployServing, type DeployOptions } from "../../src/deploy.ts";
import { DEFAULT_HARPER_PIN, fabricUpgrade, readDeployedFlairVersion, type FabricUpgradeDeps } from "../../src/fabric-upgrade.ts";
import { buildFabricUpgradeOptions, upgradeEndpointFlagsWithoutTarget } from "../../src/commands/upgrade.ts";
import { applicationProbeUrl, endpointFlagsWithoutExplicitTarget } from "../../src/lib/ops-url.ts";
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

function routePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function appBody(url: URL): Response {
  const path = routePath(url.pathname);
  if (path === "/HealthDetail") {
    return json({
      memories: { modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 599 } },
      migrations: { cyclePhase: "done", migrations: [{ id: "embedding-stamp", state: "completed", rowsRemaining: 0 }] },
    });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return json({ issuer: url.origin, token_endpoint: `${url.origin}/oauth/mcp/token` });
  }
  if (path === "/OAuthMetadata") return json({ issuer: url.origin });
  if (path === "/Memory") return json([]);
  if (path === "/Health") return json({ ok: true, version: "9.9.9-test", searchReady: true, buildCommit: null });
  return json({});
}

type Role = "both" | "ops" | "app" | "auth" | "gated";
const BASIC = `Basic ${Buffer.from("admin:pw").toString("base64")}`;

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
      const path = routePath(url.pathname);
      hits.push(req.method === "POST" ? `POST ${operation || path}` : `GET ${path}`);
      if (req.method === "POST") {
        if (operation === "deploy_component" && role !== "app") return json({ ok: true });
        return new Response("deploy refused", { status: role === "auth" ? 401 : 404 });
      }
      if (role === "auth") return new Response("unauthorized", { status: 401 });
      if (role === "gated" && path === "/Memory") {
        if (req.headers.get("authorization") !== BASIC) return new Response("unauthorized", { status: 401 });
        return json([]);
      }
      const appRoute =
        path === "/Memory" ||
        path === "/Health" ||
        path === "/HealthDetail" ||
        path === "/OAuthMetadata" ||
        path.startsWith("/.well-known/");
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
    fetchDeployedVersion: async () => "0.14.0",
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
      expect(err.message).toContain(`GET ${mock.url}/Memory/?limit(1) returned 404`);
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
      const path = new URL(String(input)).pathname.replace(/\/+$/, "");
      if (path.endsWith("/Memory")) return new Response(body, { status });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("a 200 with an empty body is refused", async () => {
    const err = await verifyDeployServing({ ...probe, fetchImpl: fetchStatus(200, "") }).then(() => {
      throw new Error("empty body was accepted");
    }, (e: Error) => e);
    expect(err.message).toContain("empty body");
    expect(err.message).toContain("JSON body");
    expect(err.message).not.toContain("--application-endpoint");
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
      const path = new URL(String(input)).pathname.replace(/\/+$/, "");
      if (path.endsWith("/Memory")) throw new Error("connect ECONNREFUSED");
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(verifyDeployServing({ ...probe, fetchImpl })).rejects.toThrow(/request to https:\/\/app\.example\/Memory\/\?limit\(1\) failed/);
  });

  test("a 503 is refused", async () => {
    const err = await verifyDeployServing({ ...probe, fetchImpl: fetchStatus(503, "unavailable") }).then(() => {
      throw new Error("503 was accepted");
    }, (e: Error) => e);
    expect(err.message).toContain("GET https://app.example/Memory/?limit(1) returned 503");
    expect(err.message).not.toContain("--application-endpoint");
    expect(err.message).not.toMatch(/\babsent\b|\bok\b|not found|wrong package root/);
  });

  test("resource probes request Harper limit(1) and refuse any other query", async () => {
    let seen = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/\/+$/, "");
      if (!path.endsWith("/Memory")) return new Response("ok", { status: 200 });
      seen = url.href;
      if (url.search !== "?limit(1)" && url.search !== "?limit(0,1)") return new Response("bad query", { status: 400 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await verifyDeployServing({ ...probe, fetchImpl, fabricUser: "admin", fabricPassword: "pw" });
    const parsed = new URL(seen);
    expect(parsed.pathname).toBe("/Memory/");
    expect(parsed.search).toBe("?limit(1)");
  });

  test("a 200 body over the probe cap is refused", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const fetchImpl = (async (input: string | URL | Request) => {
      if (!new URL(String(input)).pathname.replace(/\/+$/, "").endsWith("/Memory")) return new Response("ok", { status: 200 });
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > 1_048_576) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const err = await verifyDeployServing({ ...probe, fetchImpl, fabricUser: "admin", fabricPassword: "pw" }).then(() => {
      throw new Error("oversized body was accepted");
    }, (e: Error) => e);
    expect(err.message).toContain("exceeded 1048576 bytes");
    expect(err.message).not.toMatch(/verified serving|wrong package root/);
  });

  test("a 401 does not count as the route responding", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return new Response("[]", { status: 200 });
      return new Response("", { status: 401 });
    }) as unknown as typeof fetch;
    const err = await verifyDeployServing({ ...probe, resources: ["Memory"], fetchImpl }).then(() => {
      throw new Error("401 was accepted");
    }, (e: Error) => e);
    expect(err.message).toContain("GET https://app.example/Memory/?limit(1) returned 401");
    expect(err.message).toContain("auth gate");
    expect(err.message).not.toMatch(/wrong package root|\babsent\b|not found/);
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

  test("JSON with only a version string has no boolean ok", async () => {
    const result = await probe(() => new Response(JSON.stringify({ version: "1.2.3" }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(result.message).toContain("no boolean ok");
    expect(result.calls.deploy).toBe(0);
    expect(result.calls.npm).toBe(0);
    expect(result.calls.logs.join("\n")).not.toMatch(SUCCESS_TEXT);
  });

  test("a non-semver version is refused before deploy", async () => {
    const result = await probe(() => new Response(JSON.stringify({
      ok: true, version: "unknown", searchReady: true, buildCommit: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(result.message).toContain("not a semver");
    expect(result.calls.deploy).toBe(0);
    expect(result.calls.logs.join("\n")).not.toMatch(SUCCESS_TEXT);
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

  test("a /Health failure after deploy_component names the sent deploy and exits nonzero", async () => {
    let healthReads = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        healthReads++;
        if (healthReads === 1) {
          return new Response(JSON.stringify({ ok: true, version: "1.2.3", searchReady: true, buildCommit: null }), { status: 200 });
        }
        return new Response("", { status: 500 });
      },
    });
    const work = mkdtempSync(join(tmpdir(), "flair-930-after-"));
    const scratch = mkdtempSync(join(tmpdir(), "flair-930-after-tmp-"));
    roots.push(work, scratch);
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const proc = Bun.spawn(["bun", FIXTURE], {
        cwd: work,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PROBE_URL: url, WORK_DIR: work, TMPDIR: scratch, HOME: work },
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
      expect(stderr).toContain(`deploy_component was sent to ${url}`);
      expect(stderr).toContain("The running version is unverified: HTTP 500");
      expect(stderr).toContain(`Check GET ${url}/Health`);
      expect(stderr).not.toContain("This command stops");
      expect(output).not.toMatch(/UPGRADE_COMPLETE|Fabric now reports|upgrade complete|verified serving|already up to date|check complete/);
      expect(readDeployMarks(work)).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 60_000);
});

function readDeployMarks(work: string): number {
  const path = join(work, "deploy");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line === "written").length;
}

describe("flair#930 upgrade flags require --target", () => {
  test("the flags without --target are refused", () => {
    expect(upgradeEndpointFlagsWithoutTarget({ operationsEndpoint: "https://ops.example:9925" }))
      .toBe("flair upgrade: --operations-endpoint and --application-endpoint require --target.");
    expect(upgradeEndpointFlagsWithoutTarget({ applicationEndpoint: "https://app.example:9926" }))
      .toBe("flair upgrade: --operations-endpoint and --application-endpoint require --target.");
    expect(upgradeEndpointFlagsWithoutTarget({ target: "https://app.example", operationsEndpoint: "https://ops.example:9925" })).toBeNull();
    expect(endpointFlagsWithoutExplicitTarget("flair deploy", { operationsEndpoint: "https://ops.example:9925" }))
      .toBe("flair deploy: --operations-endpoint and --application-endpoint require --target.");
    expect(endpointFlagsWithoutExplicitTarget("flair deploy", { target: "https://app.example", applicationEndpoint: "https://app.example:9926" })).toBeNull();
  });

  test("flair deploy exits nonzero when an endpoint flag is set without --target", () => {
    const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const work = mkdtempSync(join(tmpdir(), "flair-930-deploy-notarget-"));
    roots.push(work);
    const result = spawnSync("bun", [cli, "deploy", "--operations-endpoint", "https://ops.example:9925"], {
      cwd: work,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, HOME: work },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain("flair deploy: --operations-endpoint and --application-endpoint require --target.");
    expect(output).not.toMatch(/Successfully deployed|verified serving/);
  }, 60_000);

  test("flair upgrade exits nonzero when an endpoint flag is set without --target", () => {
    const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const work = mkdtempSync(join(tmpdir(), "flair-930-notarget-"));
    roots.push(work);
    const result = spawnSync("bun", [cli, "upgrade", "--operations-endpoint", "https://ops.example:9925"], {
      cwd: work,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, HOME: work },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain("require --target");
    expect(output).not.toMatch(/UPGRADE_COMPLETE|upgrade complete|Checking for updates/);
  }, 60_000);
});

describe("flair#930 upgrade wiring", () => {
  test("fabricUpgrade reads the version from the application endpoint and passes both endpoints to deploy()", async () => {
    const seen: string[] = [];
    const deploys: DeployOptions[] = [];
    const logs: string[] = [];
    await fabricUpgrade(
      {
        target: "https://cluster.example",
        operationsEndpoint: "https://cluster.example:9925",
        applicationEndpoint: "https://cluster.example:9926",
        fabricUser: "admin",
        fabricPassword: "pw",
      },
      plantDeps({
        fetchDeployedVersion: async (o) => {
          seen.push(o.url);
          return seen.length === 1 ? "0.13.0" : "0.14.0";
        },
        deploy: async (opts) => {
          deploys.push(opts);
          return { url: opts.applicationEndpoint ?? opts.target ?? "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false };
        },
        log: (m) => logs.push(m),
      }),
    );
    expect(seen).toEqual(["https://cluster.example:9926", "https://cluster.example:9926"]);
    expect(deploys[0].target).toBe("https://cluster.example");
    expect(deploys[0].operationsEndpoint).toBe("https://cluster.example:9925");
    expect(deploys[0].applicationEndpoint).toBe("https://cluster.example:9926");
    expect(logs.join("\n")).toContain("Deploying flair 0.14.0 to https://cluster.example:9925");
  });

  test("fabricUpgrade without the new options keeps the single target for the version probe and deploy()", async () => {
    const seen: string[] = [];
    const deploys: DeployOptions[] = [];
    await fabricUpgrade(
      { target: "https://single.example", fabricUser: "admin", fabricPassword: "pw" },
      plantDeps({
        fetchDeployedVersion: async (o) => {
          seen.push(o.url);
          return seen.length === 1 ? "0.13.0" : "0.14.0";
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

      process.env.FLAIR_OPS_TARGET = "https://env-ops.example:9925";
      const envWins = buildFabricUpgradeOptions(
        {
          target: "https://app.example:9926",
          operationsEndpoint: "https://ops.example:9925",
        },
        { fabricUser: "admin", fabricPassword: "pw" },
        resolveEffectiveOpsUrl,
      );
      expect(envWins.opsUrl).toBe("https://env-ops.example:9925");
      delete process.env.FLAIR_OPS_TARGET;

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

function flairHealth(version: string): Response {
  return new Response(JSON.stringify({ ok: true, version, searchReady: true, buildCommit: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("flair#930 unverified version after deploy", () => {
  async function afterDeploy(second: () => Response): Promise<{ message: string; deploys: number }> {
    let reads = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        reads++;
        return reads === 1 ? flairHealth("1.0.0") : second();
      },
    });
    let deploys = 0;
    const { fetchDeployedVersion: _drop, ...deps } = plantDeps({
      deploy: async (opts) => {
        deploys++;
        return { url: opts.target ?? "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false };
      },
    });
    try {
      const err = await fabricUpgrade(
        { target: `http://127.0.0.1:${server.port}`, fabricUser: "admin", fabricPassword: "pw" },
        deps,
      ).then(() => {
        throw new Error("unverified version was treated as success");
      }, (e: Error) => e);
      return { message: err.message, deploys };
    } finally {
      server.stop(true);
    }
  }

  test("a non-semver version after deploy_component is unverified", async () => {
    const result = await afterDeploy(() => new Response(JSON.stringify({
      ok: true, version: "unknown", searchReady: true, buildCommit: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(result.deploys).toBe(1);
    expect(result.message).toContain("deploy_component was sent");
    expect(result.message).toContain("The running version is unverified");
    expect(result.message).toContain("not a semver");
    expect(result.message).not.toContain("This command stops");
    expect(result.message).not.toContain("may still be restarting");
  });

  test("a version older than the one deployed is unverified", async () => {
    const result = await afterDeploy(() => flairHealth("0.0.1"));
    expect(result.deploys).toBe(1);
    expect(result.message).toContain("deploy_component was sent");
    expect(result.message).toContain("reported 0.0.1, which is older than 0.14.0");
    expect(result.message).not.toContain("may still be restarting");
  });

  test("one re-read accepts a version that catches up", async () => {
    let reads = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        reads++;
        if (reads === 1) return flairHealth("1.0.0");
        if (reads === 2) return flairHealth("0.0.1");
        return flairHealth("0.14.0");
      },
    });
    let deploys = 0;
    const { fetchDeployedVersion: _drop, ...deps } = plantDeps({
      deploy: async (opts) => {
        deploys++;
        return { url: opts.target ?? "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false };
      },
    });
    try {
      const result = await fabricUpgrade(
        { target: `http://127.0.0.1:${server.port}`, fabricUser: "admin", fabricPassword: "pw" },
        deps,
      );
      expect(deploys).toBe(1);
      expect(reads).toBe(3);
      expect(result.verifiedVersion).toBe("0.14.0");
    } finally {
      server.stop(true);
    }
  });

  test("--no-restart reports the deploy as staged when the running version is still older", async () => {
    let reads = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        reads++;
        return flairHealth("0.0.1");
      },
    });
    const logs: string[] = [];
    let deploys = 0;
    const { fetchDeployedVersion: _drop, ...deps } = plantDeps({
      deploy: async () => {
        deploys++;
        return { url: "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false };
      },
      log: (m) => logs.push(m),
    });
    try {
      const result = await fabricUpgrade(
        { target: `http://127.0.0.1:${server.port}`, fabricUser: "admin", fabricPassword: "pw", restart: false },
        deps,
      );
      expect(deploys).toBe(1);
      expect(reads).toBe(1);
      expect(result.deployed).toBe(true);
      expect(result.verifiedVersion).toBeNull();
      expect(logs.join("\n")).toContain("The running version changes at the next restart");
      expect(logs.join("\n")).not.toContain("unverified");
    } finally {
      server.stop(true);
    }
  });

  test("a prerelease does not pass the post-deploy version check", async () => {
    let n = 0;
    const err = await fabricUpgrade(
      { target: "https://cluster.example", fabricUser: "admin", fabricPassword: "pw" },
      plantDeps({
        fetchDeployedVersion: async () => (++n === 1 ? "0.1.0" : "0.14.0-rc.1"),
        deploy: async () => ({ url: "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false }),
      }),
    ).then(() => {
      throw new Error("prerelease was treated as the deployed version");
    }, (e: Error) => e);
    expect(n).toBe(2);
    expect(err.message).toContain("deploy_component was sent");
    expect(err.message).toContain("not a stable semver");
  });
});

describe("flair#930 credentials stay on the operations host", () => {
  test("different hosts are refused before any deploy", async () => {
    let deploys = 0;
    const err = await fabricUpgrade(
      {
        target: "https://app.example:9926",
        operationsEndpoint: "https://ops.example:9925",
        applicationEndpoint: "https://app.example:9926",
        fabricUser: "admin",
        fabricPassword: "pw",
      },
      plantDeps({
        deploy: async () => {
          deploys++;
          return { url: "", project: "flair", version: "0.14.0", packageRoot: "", dryRun: false };
        },
      }),
    ).then(() => {
      throw new Error("different hosts were accepted");
    }, (e: Error) => e);
    expect(deploys).toBe(0);
    expect(err.message).toContain("the application endpoint host app.example is not the operations endpoint host ops.example");
    expect(err.message).toContain("Refusing to send admin credentials to both hosts");
  });

  test("flair deploy refuses different hosts before a dry run returns", async () => {
    await expect(deploy(deployOpts({
      target: "https://app.example:9926",
      operationsEndpoint: "https://ops.example:9925",
      dryRun: true,
    }))).rejects.toThrow(/application endpoint host app\.example is not the operations endpoint host ops\.example/);
  });
});

describe("flair#930 credentialed resource probes", () => {
  test("anonymous 401 and a credentialed JSON row list passes", async () => {
    const mock = startMock("gated");
    try {
      const result = await deploy(deployOpts({ target: mock.url }));
      expect(result.url).toBe(mock.url);
      expect(mock.hits).toContain("GET /Memory");
    } finally {
      mock.stop();
    }
  });

  test("without Basic credentials, resource verification does not run", () => {
    expect(resourceVerificationSkip(undefined, undefined)).toContain("resource verification did not run");
    expect(resourceVerificationSkip("admin", "pw")).toBeNull();
  });

  test("token-only names that resource verification did not run and does not report a 401", async () => {
    const err = await deploy(deployOpts({
      target: "https://cluster.example:9926",
      fabricUser: undefined,
      fabricPassword: undefined,
      fabricToken: "tok",
      verify: true,
    })).then(() => {
      throw new Error("token-only was a pass");
    }, (e: Error) => e);
    expect(err.message).toContain("not yet supported");
    expect(err.message).toContain("resource verification did not run");
    expect(err.message).not.toContain("returned 401");
  });
});

describe("flair#930 /Health shape", () => {
  test("a pre-#1326 body passes the pre-deploy read and fails the strict post-deploy read", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ ok: true, version: "0.20.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const pre = await readDeployedFlairVersion({
        url,
        project: "flair",
        fabricUser: "admin",
        fabricPassword: "pw",
        healthShape: "pre-deploy",
      });
      expect(pre).toBe("0.20.1");
      const err = await readDeployedFlairVersion({
        url,
        project: "flair",
        fabricUser: "admin",
        fabricPassword: "pw",
        healthShape: "post-deploy",
      }).then(() => {
        throw new Error("strict read accepted an old body");
      }, (e: Error) => e);
      expect(err.message).toContain("not a Flair /Health body");
    } finally {
      server.stop(true);
    }
  });
});

describe("flair#930 a 401 from the wrong endpoint", () => {
  test("401 on application routes is refused and does not claim a wrong package root", async () => {
    const mock = startMock("auth");
    try {
      const err = await deploy(deployOpts({ target: mock.url })).then(() => {
        throw new Error("401 was accepted");
      }, (e: Error) => e);
      expect(err.message).toContain(`GET ${mock.url}/Memory/?limit(1) returned 401`);
      expect(err.message).toContain("auth gate");
      expect(err.message).not.toMatch(/wrong package root|component is not serving|\babsent\b/);
      expect(mock.hits).toContain("POST deploy_component");
      expect(mock.hits).toContain("GET /Memory");
    } finally {
      mock.stop();
    }
  });
});

describe("flair#930 routing matrix", () => {
  test("operations-only: deploy_component uses the operations endpoint and probes stay on the target", async () => {
    const ops = startMock("ops");
    const app = startMock("app");
    try {
      const result = await deploy(deployOpts({ target: app.url, operationsEndpoint: ops.url }));
      expect(result.url).toBe(app.url);
      expect(ops.hits).toContain("POST deploy_component");
      expect(app.hits).not.toContain("POST deploy_component");
      expect(app.hits).toContain("GET /Memory");
      expect(ops.hits).not.toContain("GET /Memory");
    } finally {
      ops.stop();
      app.stop();
    }
  });

  test("application-only: probes use the application endpoint and deploy_component stays on the target", async () => {
    const ops = startMock("ops");
    const app = startMock("app");
    try {
      const result = await deploy(deployOpts({ target: ops.url, applicationEndpoint: app.url }));
      expect(result.url).toBe(app.url);
      expect(ops.hits).toContain("POST deploy_component");
      expect(app.hits).not.toContain("POST deploy_component");
      expect(app.hits).toContain("GET /Memory");
      expect(ops.hits).not.toContain("GET /Memory");
    } finally {
      ops.stop();
      app.stop();
    }
  });

  test("the fleet probe URL is the application endpoint", () => {
    expect(applicationProbeUrl("https://cluster.example:9926", "https://cluster.example:9925")).toBe("https://cluster.example:9926");
    expect(applicationProbeUrl("  ", "https://cluster.example:9926")).toBe("https://cluster.example:9926");
  });

  test("MQTT configuration is sent to the operations endpoint", async () => {
    const seen: string[] = [];
    const err = await deploy(deployOpts({
      target: "https://cluster.example:9926",
      operationsEndpoint: "https://cluster.example:9925",
      keepMqttConfig: false,
      verify: false,
      operationsFetch: (async (input: string | URL | Request) => {
        seen.push(String(input));
        return new Response("no", { status: 500 });
      }) as typeof fetch,
    })).then(() => {
      throw new Error("MQTT refusal was treated as success");
    }, (e: Error) => e);
    expect(seen.some((url) => url.includes("https://cluster.example:9925"))).toBe(true);
    expect(seen.some((url) => url.includes(":9926"))).toBe(false);
    expect(err.message).toContain("cluster.example:9925");
  });

  test("convergence polls the operations endpoint", async () => {
    const root = packageRoot();
    writeFileSync(
      join(root, "node_modules", "harper", "dist", "bin", "harper.js"),
      'console.log("Component \'flair\' was deployed on the origin node but failed to replicate to 1 of 1 peer node(s): peer.cluster.example (Error: Connection closed 1006)."); process.exit(1);\n',
    );
    const seen: string[] = [];
    let clock = 0;
    const err = await deploy(deployOpts({
      target: "https://cluster.example:9926",
      operationsEndpoint: "https://cluster.example:9925",
      applicationEndpoint: "https://cluster.example:9926",
      packageRoot: root,
      verify: false,
      deployRetries: 0,
      convergenceTimeoutMs: 1,
      convergencePollIntervalMs: 1000,
      convergenceDeps: {
        getComponents: async (url: string) => {
          seen.push(url);
          return [];
        },
        resolveHostAddresses: async () => [],
        sleep: async () => {},
        now: () => ++clock,
      },
    })).then(() => {
      throw new Error("replication failure was treated as success");
    }, (e: Error) => e);
    expect(seen[0]).toBe("https://cluster.example:9925");
    expect(err.message).not.toContain("cluster.example:9926");
  });
});
