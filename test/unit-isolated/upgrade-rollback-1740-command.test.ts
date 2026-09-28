/**
 * upgrade-rollback-1740-command.test.ts — flair#1740 command boundary.
 *
 * Drives the real `flair upgrade` action with three seams under test control:
 *   - install: rebindCli({ runPackageInstall }) records the spec; npm is never run
 *   - restart: rebindCli({ restartAfterUpgrade }) throws the Harper timeout
 *   - health: a real /Health server (or a closed port) classified by
 *     classifyUpgradePriorLiveness — not a boolean the test hands in
 *
 * `--no-verify` skips the credential preflight. Prior liveness still runs.
 * A closed port must keep the new version (exit 0). This file imports
 * `rebindCli`, which is not on the round-1 head, so the file cannot load
 * there and cannot itself be the red-on-base proof. The behavioural red is
 * a call-site mutation: hard-coding `priorLiveness: "running"` in
 * decideAfterRestartFailure's argument makes the stopped case exit 1.
 * That failure is quoted in the PR. The pure helper tests stay in
 * test/unit/upgrade-rollback-1740.test.ts and do not see that hard-code.
 *
 * Isolated: mock.module is process-global, and this imports src/cli.ts.
 */

import { describe, test, expect, mock, spyOn, afterAll, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const TEST_HOME = mkdtempSync(join(tmpdir(), "flair-1740-cmd-home-"));
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HOME",
  "FLAIR_URL",
  "FLAIR_TARGET",
  "ROOTPATH",
  "npm_config_registry",
  "npm_config_@tpsdev-ai:registry",
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "FLAIR_ALLOW_INSECURE_REGISTRY",
] as const;
for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];
process.env.HOME = TEST_HOME;
delete process.env.FLAIR_URL;
delete process.env.FLAIR_TARGET;
delete process.env.ROOTPATH;

const userNpmrc = join(TEST_HOME, "user-npmrc");
const globalNpmrc = join(TEST_HOME, "global-npmrc");
writeFileSync(userNpmrc, "");
writeFileSync(globalNpmrc, "");
process.env.npm_config_userconfig = userNpmrc;
process.env.npm_config_globalconfig = globalNpmrc;

mock.module("node:os", () => {
  const actual = { ...require("node:os") };
  return { ...actual, homedir: () => process.env.HOME || actual.homedir() };
});

const { program } = await import("../../src/cli.ts");
const { rebindCli } = await import("../../src/commands/upgrade.ts");
const { clearNpmRegistryCache } = await import("../../src/lib/npm-registry.ts");

const START_ERROR = "Harper at port 19926 did not respond within 60000ms (120 attempts)";
const installs: string[] = [];
let restartCalls = 0;

const servers: Server[] = [];

function listen(srv: Server): Promise<number> {
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve((srv.address() as { port: number }).port);
  }));
}

function bindSeams(): void {
  installs.length = 0;
  restartCalls = 0;
  clearNpmRegistryCache();
  rebindCli({
    probeBinVersion: (_exec: unknown, bin: string) => (bin === "flair" ? "0.54.1" : null),
    probeLibVersion: () => null,
    probeOpenclawPluginVersion: () => null,
    restartAfterUpgrade: async () => {
      restartCalls += 1;
      throw new Error(START_ERROR);
    },
    runPackageInstall: (spec: string) => {
      installs.push(spec);
    },
  });
}

async function startRegistry(deprecatePrevious: boolean): Promise<string> {
  const srv = createServer((req, res) => {
    const url = req.url ?? "";
    const body = url.includes("/0.54.1")
      ? {
          name: "@tpsdev-ai/flair",
          version: "0.54.1",
          ...(deprecatePrevious ? { deprecated: "broken\u0001publish" } : {}),
        }
      : { name: "@tpsdev-ai/flair", version: "0.54.2" };
    const raw = JSON.stringify(body);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
    res.end(raw);
  });
  const port = await listen(srv);
  return `http://127.0.0.1:${port}`;
}

async function startHealth(status: number): Promise<string> {
  const srv = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/Health")) {
      res.writeHead(status);
      res.end(status === 200 ? "ok" : "nope");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(srv);
  return `http://127.0.0.1:${port}`;
}

async function closedPortUrl(): Promise<string> {
  const srv = createServer();
  const port = await listen(srv);
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function runUpgrade(args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  let code = 0;
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.map((x) => String(x)).join(" "));
  });
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit);
  try {
    await program.parseAsync(["node", "flair", "upgrade", ...args]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("process.exit(")) throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { code, out: `${logs.join("\n")}\n${errs.join("\n")}` };
}

async function pointRegistry(deprecatePrevious: boolean): Promise<void> {
  const url = await startRegistry(deprecatePrevious);
  process.env.npm_config_registry = url;
  process.env["npm_config_@tpsdev-ai:registry"] = url;
  process.env.FLAIR_ALLOW_INSECURE_REGISTRY = "1";
}

afterEach(async () => {
  delete process.env.FLAIR_URL;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("flair upgrade restart failure (flair#1740)", () => {
  test("stopped install with --no-verify keeps the new version and does not roll back", async () => {
    bindSeams();
    await pointRegistry(false);
    process.env.FLAIR_URL = await closedPortUrl();

    const { code, out } = await runUpgrade(["--no-verify"]);

    expect(code).toBe(0);
    expect(out).toContain("@tpsdev-ai/flair@0.54.2 is installed");
    expect(out).toContain("no listener accepted it");
    expect(out).toContain("does not show that no process was running");
    expect(out).toContain("Next: flair start");
    expect(out).not.toContain("Rolling back");
    expect(out).not.toContain("KNOWN-BROKEN");
    expect(out).not.toContain("Flair is NOT running");
    expect(installs).toEqual(["@tpsdev-ai/flair@0.54.2"]);
    expect(restartCalls).toBe(1);
  });

  test("a running instance still rolls back, and a failed rollback restart is known-broken", async () => {
    bindSeams();
    await pointRegistry(false);
    process.env.FLAIR_URL = await startHealth(200);

    const { code, out } = await runUpgrade(["--no-verify"]);

    expect(code).toBe(1);
    expect(out).toContain("Rolling back @tpsdev-ai/flair to 0.54.1");
    expect(out).toContain("KNOWN-BROKEN");
    expect(out).toContain("npm install -g @tpsdev-ai/flair@0.54.2");
    expect(out).toContain("did not start on this attempt");
    expect(out).toContain("not guaranteed non-deprecated");
    expect(out).not.toContain("cannot start");
    expect(out).not.toContain("Flair is NOT running");
    expect(out).toContain("No pre-upgrade data snapshot was restored");
    expect(out).not.toContain("was not running before this upgrade");
    expect(out).not.toContain("do not npm install -g");
    expect(installs).toEqual(["@tpsdev-ai/flair@0.54.2", "@tpsdev-ai/flair@0.54.1"]);
    expect(restartCalls).toBe(2);
  });

  test("HTTP 500 /Health with --no-verify is indeterminate and still rolls back", async () => {
    bindSeams();
    await pointRegistry(false);
    process.env.FLAIR_URL = await startHealth(500);

    const { code, out } = await runUpgrade(["--no-verify"]);

    expect(code).toBe(1);
    expect(out).toContain("indeterminate");
    expect(out).toContain("HTTP 500");
    expect(out).toContain("Rolling back @tpsdev-ai/flair to 0.54.1");
    expect(out).not.toContain("was not running before this upgrade");
    expect(installs).toContain("@tpsdev-ai/flair@0.54.1");
    expect(restartCalls).toBe(2);
  });

  test("a deprecated previous version is not reinstalled", async () => {
    bindSeams();
    await pointRegistry(true);
    process.env.FLAIR_URL = await startHealth(200);

    const { code, out } = await runUpgrade(["--no-verify"]);

    expect(code).toBe(1);
    expect(out).toContain("Not rolling back");
    expect(out).toContain("@tpsdev-ai/flair@0.54.1");
    expect(out).toContain("brokenpublish");
    expect(out).not.toContain("\u0001");
    expect(out).not.toContain("Rolling back @tpsdev-ai/flair to 0.54.1");
    expect(installs).toEqual(["@tpsdev-ai/flair@0.54.2"]);
    expect(restartCalls).toBe(1);
  });
});
