/**
 * upgrade-registry-resolution.test.ts — flair#1688 (fails-first) + flair#1692.
 *
 * THE BUG. `flair upgrade`'s update check fetched `registry.npmjs.org` with a
 * hardcoded host, so `npm config` — the default `registry`, the
 * `@tpsdev-ai:registry` scope mapping, any `.npmrc` — never influenced it. A
 * user (or CI lane) pointed at a private mirror was compared against the
 * PUBLIC `latest` dist-tag: a wrong "you are current", or a download from the
 * registry the operator configured away from.
 *
 * THE PROOF. Serve a different `latest` from a local HTTP registry, point npm
 * config at it, run the real `flair upgrade --check` command, and assert the
 * listing reports THAT registry's version. Cases:
 *   1. `registry` (the default) points at the local registry.
 *   2. only `@tpsdev-ai:registry` is set and the default is unset.
 *   3. the resolved registry + source are PRINTED (flair#1692 item 1).
 *   4. a non-semver `latest` is refused, never listed as an upgrade (item 3).
 *   5. a non-loopback plain-http registry is refused with a remedy (item 2).
 *   6. a 302 from an allowed registry is not followed (item 5).
 *
 * Isolated because it imports `src/cli.ts` (same reason as the plain-tree
 * wiring test). Real fetch is used on purpose — the point is the URL the
 * product builds.
 *
 * The stub registry does not forward upstream, so it is not an SSRF sink
 * (flair#1692 Q3). `local-npm-registry.mjs` (scripts/ci) is the lane's shim for
 * the same job; it is not on main yet (it ships with the #1684 lane), so this
 * test owns a minimal stand-in and the shim reuse is noted as a #1684 follow-up.
 */

import { describe, test, expect, spyOn, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Own HOME before importing cli.ts: modules resolve ~/.flair at import time.
const TEST_HOME = mkdtempSync(join(tmpdir(), "flair-registry-resolve-home-"));
process.env.HOME = TEST_HOME;

const { program } = await import("../../src/cli.ts");

const STUB_VERSION = "9.9.9";
const ENV_KEYS = [
  "npm_config_registry",
  "npm_config_@tpsdev-ai:registry",
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "FLAIR_ALLOW_INSECURE_REGISTRY",
] as const;

const servers: Server[] = [];
let restoreEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  restoreEnv = {};
  for (const key of ENV_KEYS) restoreEnv[key] = process.env[key];
}

function restoreEnvKeys(): void {
  for (const key of ENV_KEYS) {
    if (restoreEnv[key] === undefined) delete process.env[key];
    else process.env[key] = restoreEnv[key];
  }
}

function listen(srv: Server): Promise<number> {
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as any).port)));
}

/** A minimal npm-registry stand-in: any package's `/latest` returns `version`. */
async function startStubRegistry(version: string = STUB_VERSION): Promise<string> {
  const srv = createServer((_req, res) => {
    const body = JSON.stringify({ name: "@tpsdev-ai/flair", version });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  const port = await listen(srv);
  return `http://127.0.0.1:${port}`;
}

/** A server that 302s every request to `target` and counts what it served. */
async function startRedirectRegistry(target: string): Promise<{ url: string; followed: () => number }> {
  let followed = 0;
  const srv = createServer((req, res) => {
    followed++;
    res.writeHead(302, { location: `${target}${req.url ?? "/"}` });
    res.end();
  });
  const port = await listen(srv);
  return { url: `http://127.0.0.1:${port}`, followed: () => followed };
}

async function runUpgradeCheck(): Promise<{ logs: string; errs: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.map((a) => String(a)).join(" "));
  });
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit);
  try {
    await program.parseAsync(["node", "flair", "upgrade", "--check"]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("process.exit(")) throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs: logs.join("\n"), errs: errs.join("\n") };
}

/** Isolate npm's user/global config so the runner's own .npmrc cannot leak in. */
function isolateNpmConfig(): void {
  const userConfig = join(TEST_HOME, "user-npmrc");
  const globalConfig = join(TEST_HOME, "global-npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  process.env.npm_config_userconfig = userConfig;
  process.env.npm_config_globalconfig = globalConfig;
}

afterEach(async () => {
  restoreEnvKeys();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("flair upgrade --check registry resolution", () => {
  test("default registry: reports the version from the configured registry", async () => {
    snapshotEnv();
    isolateNpmConfig();
    const url = await startStubRegistry();
    process.env.npm_config_registry = url;

    const { logs } = await runUpgradeCheck();
    expect(logs).toContain(`@tpsdev-ai/flair`);
    expect(logs).toContain(STUB_VERSION);
  });

  test("scope mapping with default unset: reports the scoped registry's version", async () => {
    snapshotEnv();
    isolateNpmConfig();
    const url = await startStubRegistry();
    delete process.env.npm_config_registry;
    process.env["npm_config_@tpsdev-ai:registry"] = url;

    const { logs } = await runUpgradeCheck();
    expect(logs).toContain(`@tpsdev-ai/flair`);
    expect(logs).toContain(STUB_VERSION);
  });

  test("flair#1692 item 1: the resolved registry and its source are printed", async () => {
    snapshotEnv();
    isolateNpmConfig();
    const url = await startStubRegistry();
    process.env.npm_config_registry = url;

    const { logs } = await runUpgradeCheck();
    expect(logs).toContain(`registry: ${url} (source: env npm_config_registry)`);
  });

  test("flair#1692 item 3: a non-semver latest is refused, never listed", async () => {
    snapshotEnv();
    isolateNpmConfig();
    const url = await startStubRegistry("https://attacker.example/x.tgz");
    process.env.npm_config_registry = url;

    const { logs, errs } = await runUpgradeCheck();
    expect(errs).toContain("non-semver");
    expect(errs).toContain("https://attacker.example/x.tgz");
    // Never becomes an upgrade plan / install target.
    expect(logs).not.toContain("→ https://attacker.example/x.tgz");
    expect(logs).not.toContain("Installing @tpsdev-ai/flair@https://attacker.example/x.tgz");
  });

  test("flair#1692 item 2: a non-loopback plain-http registry is refused with a remedy", async () => {
    snapshotEnv();
    isolateNpmConfig();
    process.env.npm_config_registry = "http://evil.internal:8080";

    const { errs } = await runUpgradeCheck();
    expect(errs).toContain("Refusing npm registry");
    expect(errs).toContain("actor:");
    expect(errs).toContain("remedy:");
    expect(errs).toContain("FLAIR_ALLOW_INSECURE_REGISTRY=1");
  });

  test("flair#1692 item 5: a 302 from an allowed registry is not followed", async () => {
    snapshotEnv();
    isolateNpmConfig();
    const target = await startStubRegistry("8.8.8");
    const redirect = await startRedirectRegistry(target);
    process.env.npm_config_registry = redirect.url;

    const { logs } = await runUpgradeCheck();
    // The redirect was served (we reached the registry) but never followed,
    // so the target's version must not appear anywhere.
    expect(redirect.followed()).toBeGreaterThan(0);
    expect(logs).not.toContain("8.8.8");
  });
});
