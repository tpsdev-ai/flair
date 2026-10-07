import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { actionRecallHookStatus, hookSettingsPath, installHook, installActionRecall, uninstallActionRecall } from "../../src/hook-install.ts";
import { buildActionRecallHookCommand, buildSessionStartHookCommand } from "../../src/doctor-client.ts";
import { actionRecallInstallRoot, probeActionRecallRuntime, resolveActionRecallRuntime } from "../../src/lib/action-recall-runtime.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { createActionRecallRuntime } from "../helpers/action-recall-runtime.ts";

let home: string;
let artifact: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-runtime-working-"));
  artifact = createActionRecallRuntime(home).artifactPath;
}, 30_000);
afterEach(() => rmSync(home, { recursive: true, force: true }));
const resolveRuntime = (bunPath = process.execPath, artifactPath = artifact) => resolveActionRecallRuntime({ fromUrl: import.meta.url, env: { PATH: process.env.PATH, HOME: home, FLAIR_BUN_PATH: bunPath, FLAIR_ACTION_RECALL_ARTIFACT: artifactPath } });
function installedArtifact(): string {
  const config = JSON.parse(readFileSync(hookSettingsPath(home, "claude-code"), "utf8"));
  return config.hooks.PreToolUse[0].hooks[0].command.match(/ ([^ ]+action-recall-hook\.js) 2>/)[1];
}
function status(bunPath: string, artifactPath: string) {
  const path = hookSettingsPath(home, "claude-code");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: buildSessionStartHookCommand("me") }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: buildActionRecallHookCommand(bunPath, artifactPath, "me") }] }] } }));
  return actionRecallHookStatus(home, "claude-code");
}

test("runtime and status reject an executable that is not Bun, even with Bun on PATH", () => {
  expect(resolveRuntime("/usr/bin/true").ok).toBe(false);
  expect(status("/usr/bin/true", artifact).installed).toBe(false);
});
test("runtime and status reject a regular nonscript override", () => {
  expect(resolveRuntime(process.execPath, "/etc/hosts").ok).toBe(false);
  expect(status(process.execPath, "/etc/hosts").installed).toBe(false);
});
test("runtime and status reject missing or stale embedded build versions", () => {
  for (const text of ["process.exit(0);", "// flair-action-recall-built@0.0.1\nprocess.exit(0);"]) {
    writeFileSync(artifact, text);
    expect(resolveRuntime().ok).toBe(false);
    expect(status(process.execPath, artifact).installed).toBe(false);
  }
});
test("runtime rejects a package version that differs from its built hook", () => {
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(artifact)), "package.json"), "utf8"));
  pkg.version = "0.0.1";
  writeFileSync(join(dirname(dirname(artifact)), "package.json"), JSON.stringify(pkg));
  expect(resolveRuntime().ok).toBe(false);
});
test("runtime rejects Bun versions outside the supported range or malformed version output", () => {
  const bun = join(home, "bun");
  for (const version of ["1.3.9", "2.0.0", "v1.3.10", "not Bun"]) {
    writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
    expect(resolveRuntime(bun).ok).toBe(false);
    expect(status(bun, artifact).installed).toBe(false);
  }
});
test("runtime and status pass the nonce self-test with the built hook", () => {
  expect(resolveRuntime().ok).toBe(true);
  expect(status(process.execPath, artifact).installed).toBe(true);
});
test("installation refuses invalid direct runtime inputs without writing settings", () => {
  for (const runtime of [{ bunPath: "/usr/bin/true", artifactPath: artifact }, { bunPath: process.execPath, artifactPath: "/etc/hosts" }]) {
    expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime }).ok).toBe(false);
  }
});
test("the package build stamps a hook that Bun can execute", () => {
  const packageDir = resolve(import.meta.dir, "../../packages/flair-mcp");
  execFileSync(process.execPath, ["run", "build"], { cwd: packageDir, timeout: 15_000, stdio: "pipe" });
  const result = resolveRuntime(process.execPath, join(packageDir, "dist/action-recall-hook.js"));
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const hook = spawnSync(result.runtime.bunPath, [result.runtime.artifactPath], { input: "{}", encoding: "utf8", timeout: 5000, env: { ...process.env, FLAIR_ACTION_RECALL_DIR: home } });
  expect(hook.status).toBe(0);
  expect(hook.stdout).toBe("");
  expect(hook.stderr).toBe("");
  // The package build above allows 15 s; this budget must outlast it so a slow
  // build is named here, not killed as a bare 5 s default.
}, 30_000);

for (const decoy of ["version-only runtime", "exit-only artifact", "hung runtime"]) {
  test(`install and status reject ${decoy} by name`, () => {
    let bunPath = process.execPath;
    if (decoy === "exit-only artifact") {
      writeFileSync(artifact, `// flair-action-recall-built@${flairCliVersion()}\nprocess.exit(0);\n`);
    } else {
      bunPath = join(home, "bun");
      writeFileSync(bunPath, decoy === "hung runtime"
        ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.10; else exec /bin/sleep 10; fi\n'
        : "#!/bin/sh\nprintf '1.3.10\\n'\n", { mode: 0o700 });
    }
    const runtime = { bunPath, artifactPath: artifact };
    const result = installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("action-recall self-test failed");
    expect(result.message).toContain(bunPath);
    expect(result.message).toContain(artifact);
    const observed = status(bunPath, artifact);
    expect(observed.installed).toBe(false);
    expect(observed.runtimeFailure).toContain("action-recall self-test failed");
    expect(observed.runtimeFailure).toContain(artifact);
    expect(resolveRuntime(bunPath).ok).toBe(false);
  }, 15_000);
}

for (const output of ["garbage", '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x","permissionDecision":"allow"}}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":7}}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"},"decision":"block"}']) {
  test(`certification refuses invalid context output: ${output}`, () => {
    writeFileSync(artifact, `// flair-action-recall-built@${flairCliVersion()}\nprocess.stdout.write(${JSON.stringify(output)});`);
    expect(resolveRuntime().ok).toBe(false);
    expect(status(process.execPath, artifact).installed).toBe(false);
  });
}

test("npx cache eviction leaves the provisioned hook working and uninstall removes it", () => {
  const packageDir = join(home, ".npm/_npx/fetched/node_modules/@tpsdev-ai/flair-mcp");
  mkdirSync(dirname(packageDir), { recursive: true });
  cpSync(dirname(dirname(artifact)), packageDir, { recursive: true });
  const result = resolveActionRecallRuntime({ fromUrl: new URL(`file://${home}/cli/dist/cli.js`).href, env: { HOME: home, FLAIR_BUN_PATH: process.execPath } });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.runtime.artifactPath).toBe(join(packageDir, "dist/action-recall-hook.js"));
  installHook({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926" });
  expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: result.runtime }).ok).toBe(true);
  const durable = installedArtifact();
  expect(durable.startsWith(join(actionRecallInstallRoot(home), `${flairCliVersion()}-`))).toBe(true);
  expect(durable).not.toContain("_npx");
  expect(statSync(dirname(dirname(durable))).mode & 0o777).toBe(0o700);
  expect(statSync(dirname(durable)).mode & 0o777).toBe(0o700);
  expect(statSync(durable).mode & 0o777).toBe(0o600);
  rmSync(join(home, ".npm/_npx/fetched"), { recursive: true, force: true });
  expect(probeActionRecallRuntime({ ...result.runtime, artifactPath: durable }, "me")).toBeNull();
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(true);
  expect(uninstallActionRecall({ homeDir: home, harness: "claude-code", dryRun: true }).ok).toBe(true);
  expect(existsSync(durable)).toBe(true);
  expect(uninstallActionRecall({ homeDir: home, harness: "claude-code" }).ok).toBe(true);
  expect(existsSync(actionRecallInstallRoot(home))).toBe(false);
});

test("an empty standard npx cache refuses by package name with the fetch remedy", () => {
  const result = resolveActionRecallRuntime({ fromUrl: new URL(`file://${home}/cli/dist/cli.js`).href, env: { HOME: home, FLAIR_BUN_PATH: process.execPath } });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected runtime");
  expect(result.reason).toContain(`npx -y -p @tpsdev-ai/flair-mcp@${flairCliVersion()} node --version`);
});

test("status probes the artifact again after installation", () => {
  const runtime = { bunPath: process.execPath, artifactPath: artifact };
  expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime }).ok).toBe(true);
  writeFileSync(installedArtifact(), `// flair-action-recall-built@${flairCliVersion()}\nprocess.exit(0);`);
  const observed = actionRecallHookStatus(home, "claude-code");
  expect(observed.installed).toBe(false);
  expect(observed.runtimeFailure).toContain("action-recall self-test failed");
});

test("the built CLI names rejected runtime and artifact decoys", () => {
  const cli = resolve(import.meta.dir, "../../dist/cli.js");
  installHook({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926" });
  expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: { bunPath: process.execPath, artifactPath: artifact } }).ok).toBe(true);
  const healthy = spawnSync("node", [cli, "hook", "status", "--action-recall"], { encoding: "utf8", timeout: 15_000, env: { HOME: home, USERPROFILE: home, TMPDIR: tmpdir(), PATH: process.env.PATH } });
  expect(healthy.status).toBe(0);
  expect(healthy.stdout).toContain("refresh enabled");
  const bunPath = join(home, "bun");
  writeFileSync(bunPath, "#!/bin/sh\nprintf '1.3.10\\n'\n", { mode: 0o700 });
  for (const runtime of [{ bunPath, artifactPath: artifact }, { bunPath: process.execPath, artifactPath: artifact }]) {
    if (runtime.bunPath === process.execPath) writeFileSync(installedArtifact(), `// flair-action-recall-built@${flairCliVersion()}\nprocess.exit(0);`);
    const env = { HOME: home, USERPROFILE: home, TMPDIR: tmpdir(), PATH: process.env.PATH, FLAIR_BUN_PATH: runtime.bunPath, FLAIR_ACTION_RECALL_ARTIFACT: artifact };
    const result = spawnSync("node", [cli, "hook", "install", "--action-recall", "--agent", "me"], { encoding: "utf8", timeout: 15_000, env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("action-recall self-test failed");
    expect(result.stderr).toContain(runtime.bunPath);
    status(runtime.bunPath, artifact);
    const observed = spawnSync("node", [cli, "hook", "status", "--action-recall"], { encoding: "utf8", timeout: 15_000, env });
    expect(observed.status).toBe(1);
    expect(observed.stdout).toContain("action-recall self-test failed");
    expect(observed.stdout).toContain(installedArtifact());
  }
}, 60_000);


test("the installed command launches Bun only for the hook", () => {
  const bunPath = join(home, "traced-bun");
  const calls = join(home, "bun-calls");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" != --version ]; then printf '%s\\n' "$1" >> ${quote(calls)}; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  expect(probeActionRecallRuntime({ bunPath, artifactPath: artifact })).toBeNull();
  const invocations = readFileSync(calls, "utf8").trim().split("\n");
  expect(invocations.length).toBeGreaterThanOrEqual(2);
  expect(invocations.every(value => value === artifact)).toBe(true);
});

test("a same-version runtime refresh publishes a new generation without replacing the old one", () => {
  const runtime = { bunPath: process.execPath, artifactPath: artifact };
  const options = { homeDir: home, harness: "claude-code" as const, agentId: "me", flairUrl: "http://localhost:19926", runtime };
  expect(installActionRecall(options).ok).toBe(true);
  const before = installedArtifact();
  writeFileSync(artifact, readFileSync(artifact, "utf8") + "\n");
  expect(installActionRecall(options).ok).toBe(true);
  const after = installedArtifact();
  expect(after).not.toBe(before);
  expect(existsSync(before)).toBe(true);
  rmSync(dirname(dirname(artifact)), { recursive: true, force: true });
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(true);
  expect(uninstallActionRecall({ homeDir: home, harness: "claude-code" }).ok).toBe(true);
  expect(existsSync(before)).toBe(false);
  expect(existsSync(after)).toBe(false);
});

test("a missing runtime module refuses provisioning without writing settings", () => {
  rmSync(join(dirname(artifact), "secret-redaction.js"));
  expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: { bunPath: process.execPath, artifactPath: artifact } }).ok).toBe(false);
  expect(existsSync(hookSettingsPath(home, "claude-code"))).toBe(false);
});

test("install upgrades a stale versioned hook and uninstall removes both versions", () => {
  const oldPackage = join(actionRecallInstallRoot(home), "0.0.1-old");
  mkdirSync(dirname(oldPackage), { recursive: true, mode: 0o700 });
  cpSync(dirname(dirname(artifact)), oldPackage, { recursive: true });
  const oldArtifact = join(oldPackage, "dist/action-recall-hook.js");
  const pkgPath = join(oldPackage, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = "0.0.1";
  writeFileSync(pkgPath, JSON.stringify(pkg));
  writeFileSync(oldArtifact, readFileSync(oldArtifact, "utf8").replace(`flair-action-recall-built@${flairCliVersion()}`, "flair-action-recall-built@0.0.1"));
  expect(status(process.execPath, oldArtifact).installed).toBe(false);
  expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime: { bunPath: process.execPath, artifactPath: artifact } }).ok).toBe(true);
  expect(installedArtifact()).not.toBe(oldArtifact);
  expect(actionRecallHookStatus(home, "claude-code").installed).toBe(true);
  expect(uninstallActionRecall({ homeDir: home, harness: "claude-code" }).ok).toBe(true);
  expect(existsSync(oldPackage)).toBe(false);
});

test("install refuses a provisioned directory replaced with a cache symlink", () => {
  const runtime = { bunPath: process.execPath, artifactPath: artifact };
  const options = { homeDir: home, harness: "claude-code" as const, agentId: "me", flairUrl: "http://localhost:19926", runtime };
  expect(installActionRecall(options).ok).toBe(true);
  const destination = dirname(dirname(installedArtifact()));
  const settingsPath = hookSettingsPath(home, "claude-code");
  const before = readFileSync(settingsPath, "utf8");
  rmSync(destination, { recursive: true, force: true });
  symlinkSync(dirname(dirname(artifact)), destination);
  expect(installActionRecall(options).ok).toBe(false);
  expect(readFileSync(settingsPath, "utf8")).toBe(before);
  expect(existsSync(artifact)).toBe(true);
});
