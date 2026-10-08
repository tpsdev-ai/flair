import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let latestVersion = "0.60.0";
const registry = await import("../../src/lib/npm-registry.ts");
mock.module("../../src/lib/npm-registry.ts", () => ({
  ...registry,
  fetchLatestVersion: async () => ({ kind: "ok", version: latestVersion }),
  fetchVersionDeprecation: async () => ({ kind: "active" }),
  createRegistryNoticePrinter: () => () => {},
}));
const globalBin = await import("../../src/install/global-bin-path.ts");
mock.module("../../src/install/global-bin-path.ts", () => ({ ...globalBin, resolveNpmGlobalPrefix: async () => null }));
const execPath = await import("../../src/lib/upgrade-exec-path.ts");
mock.module("../../src/lib/upgrade-exec-path.ts", () => ({ ...execPath, findFlairPackageDir: () => null }));
const { bindCli, rebindCli, register } = await import("../../src/commands/upgrade.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "flair-2270-command-")));
let packageDir: string;
let restartCalls: number;
let installCalls: number;
let log: string[];
let requests: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;
let caseIndex = 0;
const saved = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/^(FLAIR_|OAUTH_|FABRIC_)/.test(key)) delete process.env[key];
  process.env.HOME = root;
  packageDir = mkdtempSync(join(root, `install-${caseIndex++}-`));
  writeFileSync(join(packageDir, "config.yaml"), "name: flair\n");
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.59.0" }));
  latestVersion = "0.60.0";
  restartCalls = 0;
  installCalls = 0;
  log = [];
  requests = [];
  logSpy = spyOn(console, "log").mockImplementation((...args) => { log.push(args.join(" ")); });
  errorSpy = spyOn(console, "error").mockImplementation((...args) => { log.push(args.join(" ")); });
  exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("fixture exit"); }) as typeof process.exit);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async input => {
    requests.push(String(input));
    return Response.json({ issuer: "https://unrelated.example", dependencies: { harper: "5.2.8" } });
  }) as typeof fetch);
  const bindings: Partial<import("../../src/commands/upgrade.ts").UpgradeCli> = {
    flairPackageDir: () => packageDir,
    defaultDataDir: () => join(root, "absent-data"),
    resolveInstanceServingPid: () => null,
    assessInstallTree: () => ({ state: "unknown" }),
    resolveHttpPort: () => 9,
    probeBinVersion: (_exec, bin) => bin === "flair" ? "0.59.0" : null,
    probeLibVersion: () => null,
    probeOpenclawPluginVersion: () => null,
    resolveFlairMcpFinding: () => ({ installed: null, status: "missing" }),
    shouldPrintUpgradeLine: () => true,
    upgradeStatusSuffix: () => "",
    resolveUpgradeRestartVerify: opts => ({ restart: opts.restart !== false, verify: false, deprecatedRestartFlagUsed: false }),
    runPackageInstall: () => { installCalls++; },
    observeLaunchdManagement: () => ({ state: "not-applicable" }),
    resolveInstalledFlairCli: () => ({ ok: false, reason: "fixture" }),
    restartAfterUpgrade: async () => {
      restartCalls++;
      expect(readFileSync(join(packageDir, ".env"), "utf8")).toContain("OAUTH_GITHUB_REDIRECT_URI=https://local.example/oauth");
      return true;
    },
    resolveFabricCredentials: () => ({ warnings: [] }),
  };
  bindCli(bindings as import("../../src/commands/upgrade.ts").UpgradeCli);
});
afterEach(() => {
  logSpy.mockRestore(); errorSpy.mockRestore(); fetchSpy.mockRestore(); exitSpy.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function configured() {
  writeFileSync(join(packageDir, ".env"), "FLAIR_MCP_OAUTH=true\nFLAIR_MCP_ISSUER=https://local.example\nOAUTH_GITHUB_CLIENT_ID=fixture-id\nOAUTH_GITHUB_CLIENT_SECRET=fixture-secret\n");
}
async function upgrade(args: string[]) {
  const program = new Command();
  register(program);
  await program.parseAsync(["node", "flair", "upgrade", ...args]);
}

test.each([{ args: ["--no-restart", "--no-verify"] }, { args: ["--no-verify"] }])("upgrade stages local redirect before returning or restarting: %j", async ({ args }) => {
  configured();
  await upgrade([...args]);
  expect(installCalls).toBe(1);
  expect(restartCalls).toBe(args.some(arg => arg === "--no-restart") ? 0 : 1);
  expect(readFileSync(join(packageDir, ".env"), "utf8")).toContain("OAUTH_GITHUB_REDIRECT_URI=https://local.example/oauth");
  expect(requests.some(url => url.includes("OAuthMetadata"))).toBe(false);
});
test("fresh upgrade does not stage a provider", async () => {
  await upgrade(["--no-restart", "--no-verify"]);
  expect(installCalls).toBe(1);
  expect(existsSync(join(packageDir, ".env"))).toBe(false);
});
test("check leaves the redirect unstaged", async () => {
  configured();
  await upgrade(["--check"]);
  expect(installCalls).toBe(0);
  expect(readFileSync(join(packageDir, ".env"), "utf8")).not.toContain("REDIRECT_URI=");
});
test("an HTTP metadata document cannot configure the provider", async () => {
  await upgrade(["--no-restart", "--no-verify"]);
  expect(existsSync(join(packageDir, ".env"))).toBe(false);
  expect(requests.some(url => url.includes("OAuthMetadata"))).toBe(false);
});
test("Fabric route states local migration scope", async () => {
  configured();
  await expect(upgrade(["--target", "https://fabric.example", "--yes"])).rejects.toThrow("fixture exit");
  expect(log.join("\n")).toContain("OAuth redirect migration is local-only");
  expect(readFileSync(join(packageDir, ".env"), "utf8")).not.toContain("REDIRECT_URI=");
});

test("plain-tree upgrade stages the redirect in the swapped tree", async () => {
  configured();
  mkdirSync(join(packageDir, "dist"));
  writeFileSync(join(packageDir, "dist", "cli.js"), "// fixture\n");
  rebindCli({ applyPlainTreeUpgrade: async plan => {
    expect(plan.treeDir).toBe(packageDir);
    installCalls++;
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.60.0" }));
  } });
  await upgrade(["--tree", packageDir, "--no-restart", "--no-verify"]);
  expect(installCalls).toBe(1);
  expect(readFileSync(join(packageDir, ".env"), "utf8")).toContain("OAUTH_GITHUB_REDIRECT_URI=https://local.example/oauth");
});

test.each([false, true])("current packages stage a missing redirect unless check is %s", async check => {
  configured();
  latestVersion = "0.59.0";
  rebindCli({ resolveFlairMcpFinding: () => ({ installed: latestVersion, status: "current" }) });
  await upgrade(check ? ["--check"] : ["--no-restart", "--no-verify"]);
  expect(installCalls).toBe(0);
  expect(restartCalls).toBe(0);
  expect(readFileSync(join(packageDir, ".env"), "utf8").includes("OAUTH_GITHUB_REDIRECT_URI=https://local.example/oauth")).toBe(!check);
});

test("current packages leave the redirect unstaged when the serving tree differs", async () => {
  configured();
  latestVersion = "0.59.0";
  rebindCli({
    resolveFlairMcpFinding: () => ({ installed: latestVersion, status: "current" }),
    assessInstallTree: () => ({
      state: "diverged",
      cli: { dir: packageDir, version: latestVersion },
      serving: {
        kind: "proven", dir: join(root, "other-install"), version: latestVersion,
        pid: 4242, manager: "launchd", unitName: "fixture", unitPath: join(root, "fixture.plist"),
        unitNodeBin: null, unitTree: join(root, "other-install"), dropInPaths: [],
      },
    }),
  });
  await upgrade(["--no-restart", "--no-verify"]);
  expect(installCalls).toBe(0);
  expect(restartCalls).toBe(0);
  expect(readFileSync(join(packageDir, ".env"), "utf8")).not.toContain("REDIRECT_URI=");
});
