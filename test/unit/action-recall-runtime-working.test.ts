import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { actionRecallHookStatus, hookSettingsPath, installActionRecall } from "../../src/hook-install.ts";
import { buildActionRecallHookCommand } from "../../src/doctor-client.ts";
import { resolveActionRecallRuntime } from "../../src/lib/action-recall-runtime.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { createActionRecallRuntime } from "../helpers/action-recall-runtime.ts";

let home: string;
let artifact: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-runtime-working-"));
  artifact = createActionRecallRuntime(home).artifactPath;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const resolveRuntime = (bunPath = process.execPath, artifactPath = artifact) => resolveActionRecallRuntime({ fromUrl: import.meta.url, env: { PATH: process.env.PATH, HOME: home, FLAIR_BUN_PATH: bunPath, FLAIR_ACTION_RECALL_ARTIFACT: artifactPath } });
function status(bunPath: string, artifactPath: string) {
  const path = hookSettingsPath(home, "claude-code");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: buildActionRecallHookCommand(bunPath, artifactPath, "me") }] }] } }));
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
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const hook = spawnSync(result.runtime.bunPath, [result.runtime.artifactPath], { input: "{}", encoding: "utf8", timeout: 5000, env: { ...process.env, FLAIR_ACTION_RECALL_DIR: home } });
  expect(hook.status).toBe(0);
  expect(hook.stdout).toBe("");
  expect(hook.stderr).toBe("");
});

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

test("the wrapper discards version text emitted by a runtime decoy", () => {
  const bunPath = join(home, "bun");
  writeFileSync(bunPath, "#!/bin/sh\nprintf '1.3.10\\n'\n", { mode: 0o700 });
  const hook = spawnSync("/bin/sh", ["-c", buildActionRecallHookCommand(bunPath, artifact, "me")], { input: "{}", encoding: "utf8", timeout: 2000, env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(hook.status).toBe(0);
  expect(hook.stdout).toBe("");
  expect(hook.stderr).toBe("");
});

for (const output of ["garbage", '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x","permissionDecision":"allow"}}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":7}}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"},"decision":"block"}']) {
  test(`the wrapper refuses invalid context output: ${output}`, () => {
    writeFileSync(artifact, `// flair-action-recall-built@${flairCliVersion()}\nprocess.stdout.write(${JSON.stringify(output)});`);
    const hook = spawnSync("/bin/sh", ["-c", buildActionRecallHookCommand(process.execPath, artifact, "me")], { input: "{}", encoding: "utf8", timeout: 2000, env: { HOME: home, PATH: "/usr/bin:/bin" } });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe("");
    expect(hook.stderr).toBe("");
  });
}

test("status probes the artifact again after installation", () => {
  const runtime = { bunPath: process.execPath, artifactPath: artifact };
  expect(installActionRecall({ homeDir: home, harness: "claude-code", agentId: "me", flairUrl: "http://localhost:19926", runtime }).ok).toBe(true);
  writeFileSync(artifact, `// flair-action-recall-built@${flairCliVersion()}\nprocess.exit(0);`);
  const observed = actionRecallHookStatus(home, "claude-code");
  expect(observed.installed).toBe(false);
  expect(observed.runtimeFailure).toContain("action-recall self-test failed");
});

test("the built CLI names rejected runtime and artifact decoys", () => {
  const cli = resolve(import.meta.dir, "../../dist/cli.js");
  const bunPath = join(home, "bun");
  writeFileSync(bunPath, "#!/bin/sh\nprintf '1.3.10\\n'\n", { mode: 0o700 });
  for (const runtime of [{ bunPath, artifactPath: artifact }, { bunPath: process.execPath, artifactPath: artifact }]) {
    if (runtime.bunPath === process.execPath) writeFileSync(artifact, `// flair-action-recall-built@${flairCliVersion()}\nprocess.exit(0);`);
    const env = { HOME: home, USERPROFILE: home, TMPDIR: tmpdir(), PATH: process.env.PATH, FLAIR_BUN_PATH: runtime.bunPath, FLAIR_ACTION_RECALL_ARTIFACT: artifact };
    const result = spawnSync("node", [cli, "hook", "install", "--action-recall", "--agent", "me"], { encoding: "utf8", timeout: 15_000, env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("action-recall self-test failed");
    expect(result.stderr).toContain(runtime.bunPath);
    status(runtime.bunPath, artifact);
    const observed = spawnSync("node", [cli, "hook", "status", "--action-recall"], { encoding: "utf8", timeout: 15_000, env });
    expect(observed.status).toBe(1);
    expect(observed.stdout).toContain("action-recall self-test failed");
    expect(observed.stdout).toContain(artifact);
  }
}, 60_000);
