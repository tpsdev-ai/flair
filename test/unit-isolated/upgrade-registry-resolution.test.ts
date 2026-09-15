/**
 * upgrade-registry-resolution.test.ts — flair#1688 (fails-first).
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
 * listing reports THAT registry's version. Two cases:
 *   1. `registry` (the default) points at the local registry.
 *   2. only `@tpsdev-ai:registry` is set and the default is unset.
 *
 * On main this fails: the hardcoded host wins and the local version never
 * appears. `local-npm-registry.mjs` (scripts/ci) is the lane's shim for the
 * same job; it is not on main yet (it ships with the #1684 lane), so this test
 * owns a minimal stand-in and the shim reuse is noted as a #1684 follow-up.
 *
 * Isolated because it imports `src/cli.ts` (same reason as the plain-tree
 * wiring test). Real fetch is used on purpose — the point is the URL the
 * product builds.
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
] as const;

let server: Server | null = null;
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

/** A minimal npm-registry stand-in: any package's `/latest` returns STUB_VERSION. */
async function startStubRegistry(): Promise<string> {
  const srv = createServer((req, res) => {
    const body = JSON.stringify({ name: "@tpsdev-ai/flair", version: STUB_VERSION });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  server = srv;
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  if (address == null || typeof address === "string") throw new Error("stub registry has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function runUpgradeCheck(): Promise<string> {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
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
  return logs.join("\n");
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
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
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

    const text = await runUpgradeCheck();
    expect(text).toContain(`@tpsdev-ai/flair`);
    expect(text).toContain(STUB_VERSION);
  });

  test("scope mapping with default unset: reports the scoped registry's version", async () => {
    snapshotEnv();
    isolateNpmConfig();
    const url = await startStubRegistry();
    delete process.env.npm_config_registry;
    process.env["npm_config_@tpsdev-ai:registry"] = url;

    const text = await runUpgradeCheck();
    expect(text).toContain(`@tpsdev-ai/flair`);
    expect(text).toContain(STUB_VERSION);
  });
});
