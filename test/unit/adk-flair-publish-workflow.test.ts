import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { tempDir } from "../helpers/temp-dir.ts";

/**
 * The environment the fixture's git commands run under, with git's automatic
 * background maintenance turned OFF (flair#2426).
 *
 * `git fetch` finishes by spawning `git maintenance run --auto`, which detaches
 * on a git that honours `gc.autoDetach` (the default) and keeps writing into the
 * repository after `git fetch` returns. These repositories live under a
 * `tempDir()` that `bun test` sweeps as soon as the test ends, so a writer still
 * running mid-sweep leaves the directory behind for the unit lane's temp-dir
 * leak guard. `maintenance.auto=false` keeps git from spawning that command;
 * `gc.auto=0` disables the gc task behind it.
 */
function noAutomaticMaintenance(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const raw = inherited.GIT_CONFIG_COUNT;
  if (raw !== undefined && raw !== "" && !/^\d+$/.test(raw)) {
    throw new Error(`GIT_CONFIG_COUNT is not a non-negative integer: ${JSON.stringify(raw)}`);
  }
  const n = raw ? Number(raw) : 0;
  return {
    ...inherited,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: "maintenance.auto",
    [`GIT_CONFIG_VALUE_${n}`]: "false",
    [`GIT_CONFIG_KEY_${n + 1}`]: "gc.auto",
    [`GIT_CONFIG_VALUE_${n + 1}`]: "0",
  };
}

interface Step {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

const root = join(import.meta.dir, "..", "..");
const workflow = yaml.load(readFileSync(join(root, ".github/workflows/adk-flair-publish.yml"), "utf8")) as {
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: { version: { required: boolean } } } };
  jobs: { resolve: { outputs: Record<string, string>; steps: Step[] }; publish: { needs: string; concurrency: { group: string; "cancel-in-progress": boolean }; environment: string; permissions: Record<string, string>; steps: Step[] } };
};
const job = workflow.jobs.publish;
const resolve = workflow.jobs.resolve.steps.find(step => step.id === "ver")!;
const verify = job.steps.find(step => step.name === "Verify wheel and sdist on PyPI")!;
const ancestry = job.steps.find(step => step.name === "Verify tagged commit is on main")!;
const guard = job.steps.find(step => step.name === "Verify pyproject.toml version matches the tag")!;

function runVersion(ref: string, projectVersion: string, input?: string) {
  const cwd = tempDir("flair-adk-publish-");
  mkdirSync(join(cwd, "packages/adk-flair"), { recursive: true });
  writeFileSync(join(cwd, "packages/adk-flair/pyproject.toml"), `[project]\nversion = "${projectVersion}"\n`);
  const output = join(cwd, "output");
  writeFileSync(output, "");
  const resolved = spawnSync("bash", ["-e", "-o", "pipefail", "-c", resolve.run!], {
    cwd, encoding: "utf8",
    env: { ...process.env, EVENT: input === undefined ? "push" : "workflow_dispatch", REF_NAME: ref, INPUT_VERSION: input ?? "", GITHUB_OUTPUT: output },
  });
  if (resolved.status !== 0) return { status: resolved.status, text: resolved.stdout + resolved.stderr, version: "" };
  const version = readFileSync(output, "utf8").trim().replace(/^version=/, "");
  const checked = spawnSync("bash", ["-e", "-o", "pipefail", "-c", guard.run!], {
    cwd, encoding: "utf8", env: { ...process.env, VERSION: version },
  });
  return { status: checked.status, text: resolved.stdout + resolved.stderr + checked.stdout + checked.stderr, version };
}

describe("adk-flair publishing", () => {
  test("both tag triggers and the manual fallback reach the protected job", () => {
    expect(workflow.on.push.tags).toEqual(["v*", "adk-flair-v*"]);
    expect(workflow.on.workflow_dispatch.inputs.version.required).toBe(true);
    expect(job.environment).toBe("adk-flair-publish");
    expect(job.permissions).toEqual({ "id-token": "write", contents: "read" });
    expect(resolve.env).toEqual({ EVENT: "${{ github.event_name }}", REF_NAME: "${{ github.ref_name }}", INPUT_VERSION: "${{ inputs.version }}" });
    expect(guard.env?.VERSION).toBe("${{ needs.resolve.outputs.version }}");
  });

  test("version and ancestry guards run before the pinned publisher", () => {
    const publishIndex = job.steps.findIndex(step => step.uses?.startsWith("pypa/gh-action-pypi-publish@"));
    expect(publishIndex).toBeGreaterThan(-1);
    expect(job.steps[publishIndex].uses).toMatch(/@[a-f0-9]{40}$/);
    expect(job.needs).toBe("resolve");
    expect(workflow.jobs.resolve.outputs.version).toBe("${{ steps.ver.outputs.version }}");
    expect(resolve.if).toBeUndefined();
    expect(resolve["continue-on-error"]).toBeUndefined();
    for (const step of [guard, ancestry]) {
      expect(step.run).toBeTruthy();
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
      expect(job.steps.indexOf(step)).toBeLessThan(publishIndex);
    }
    expect(job.concurrency).toEqual({ group: "adk-flair-publish-${{ needs.resolve.outputs.version }}", "cancel-in-progress": false });
    expect(verify.env?.VERSION).toBe("${{ needs.resolve.outputs.version }}");
    expect(job.steps[publishIndex].uses).toBe("pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33");
    expect(job.steps[publishIndex].with).toEqual({ "packages-dir": "packages/adk-flair/dist", "skip-existing": true });
    expect(job.steps.findIndex(step => step.name === "Build wheel and sdist")).toBeLessThan(publishIndex);
    expect(job.steps.indexOf(verify)).toBeGreaterThan(publishIndex);
    expect(job.steps.findIndex(step => step.name === "Summary")).toBeGreaterThan(job.steps.indexOf(verify));
    for (const step of job.steps) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
  });

  test("git maintenance settings are appended after inherited GIT_CONFIG pairs", () => {
    const empty = noAutomaticMaintenance({});
    expect(empty).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0",
    });
    expect(noAutomaticMaintenance({ GIT_CONFIG_COUNT: "0" })).toEqual(empty);
    expect(noAutomaticMaintenance({ GIT_CONFIG_COUNT: "" })).toEqual(empty);
    const inherited = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Inherited",
      GIT_CONFIG_KEY_1: "core.editor", GIT_CONFIG_VALUE_1: "true",
    };
    expect(noAutomaticMaintenance(inherited)).toEqual({
      ...inherited,
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_2: "maintenance.auto", GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "gc.auto", GIT_CONFIG_VALUE_3: "0",
    });
    for (const bad of ["two", "-1", "1.5", " 2"]) {
      expect(() => noAutomaticMaintenance({ GIT_CONFIG_COUNT: bad })).toThrow("GIT_CONFIG_COUNT is not a non-negative integer");
    }
  });

  for (const mode of ["accepted", "rejected", "fetch failure"] as const) {
    test(`ancestry guard: ${mode}`, () => {
      const cwd = tempDir("flair-adk-ancestry-");
      const origin = join(cwd, "origin");
      const checkout = join(cwd, "checkout");
      mkdirSync(origin);
      mkdirSync(checkout);
      function git(args: string[], dir: string, input?: string) {
        const result = spawnSync("git", args, { cwd: dir, input, encoding: "utf8", env: noAutomaticMaintenance() });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout.trim();
      }
      git(["init", "--bare", "-q"], origin);
      const tree = git(["hash-object", "-t", "tree", "-w", "--stdin"], origin, "");
      function commit(dir: string, message: string, parent?: string) {
        return git(["hash-object", "-t", "commit", "-w", "--stdin"], dir,
          `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\n${message}\n`);
      }
      const accepted = commit(origin, "accepted");
      const main = commit(origin, "main", accepted);
      git(["update-ref", "refs/heads/main", main], origin);
      git(["init", "-q"], checkout);
      git(["remote", "add", "origin", mode === "fetch failure" ? join(cwd, "absent") : origin], checkout);
      const rejected = commit(checkout, "rejected");
      const sha = mode === "rejected" ? rejected : accepted;
      const result = spawnSync("bash", ["-c", ancestry.run!], {
        cwd: checkout, encoding: "utf8", env: { ...noAutomaticMaintenance(), GITHUB_SHA: sha },
      });
      const text = result.stdout + result.stderr;
      if (mode === "fetch failure") expect(result.status, text).not.toBe(0);
      else expect(result.status, text).toBe(mode === "accepted" ? 0 : 1);
      if (mode === "accepted") expect(text).toContain(`ok ${sha} is on main`);
      if (mode === "rejected") expect(text).toContain(`Commit ${sha} is not an ancestor of origin/main`);
      if (mode === "fetch failure") expect(text).not.toContain(" is on main");
    });
  }

  for (const scenario of ["complete", "missing wheel", "missing sdist", "wheel mismatch", "sdist mismatch", "lookup error", "HTTP error", "invalid JSON"] as const) {
    test(`PyPI verification: ${scenario}`, () => {
      const cwd = tempDir("flair-adk-pypi-");
      const dist = join(cwd, "packages/adk-flair/dist");
      mkdirSync(dist, { recursive: true });
      const names = ["adk_flair-0.59.0-py3-none-any.whl", "adk_flair-0.59.0.tar.gz"];
      const files = names.map(filename => {
        const data = `built ${filename}`;
        writeFileSync(join(dist, filename), data);
        return { filename, digests: { sha256: createHash("sha256").update(data).digest("hex") } };
      });
      const affected = scenario.includes("sdist") ? names[1] : names[0];
      const urls = files.filter(file => !scenario.startsWith("missing") || file.filename !== affected)
        .map(file => scenario.endsWith("mismatch") && file.filename === affected ? { ...file, digests: { sha256: "0".repeat(64) } } : file);
      const args = join(cwd, "args");
      writeFileSync(join(cwd, "curl"), `#!/bin/bash
printf "%s\\n" "$@" > "$LOOKUP_ARGS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then printf "%s" "$LOOKUP_BODY" > "$2"; shift; fi
  shift
done
exit "$LOOKUP_EXIT"
`, { mode: 0o755 });
      const result = spawnSync("bash", ["-c", verify.run!], {
        cwd, encoding: "utf8",
        env: { ...process.env, PATH: `${cwd}:${process.env.PATH}`, VERSION: "0.59.0", RUNNER_TEMP: cwd, LOOKUP_ARGS: args,
          LOOKUP_BODY: scenario === "invalid JSON" ? "invalid" : JSON.stringify({ urls }),
          LOOKUP_EXIT: scenario === "lookup error" ? "7" : scenario === "HTTP error" ? "22" : "0" },
      });
      const text = result.stdout + result.stderr;
      expect(result.status, text).toBe(scenario === "complete" ? 0 : 1);
      const request = readFileSync(args, "utf8");
      expect(request).toContain("https://pypi.org/pypi/adk-flair/0.59.0/json\n");
      expect(request).toContain("--fail\n");
      expect(request).toContain("--max-time\n30\n");
      if (scenario === "complete") {
        for (const file of files) expect(text).toContain(`Verified ${file.filename}: ${file.digests.sha256}`);
      }
      if (scenario.startsWith("missing")) expect(text).toContain(`Missing PyPI file: ${affected}`);
      if (scenario.endsWith("mismatch")) expect(text).toContain(`SHA256 mismatch for PyPI file: ${affected}`);
      if (scenario.endsWith("error")) expect(text).toContain("::error::PyPI lookup failed");
      if (scenario === "invalid JSON") expect(text).toContain("::error::Invalid PyPI file list");
    });
  }

  for (const ref of ["v0.59.0", "adk-flair-v0.59.0", "adk-flair-v0.59.0-rc.1"]) {
    const version = ref.replace(/^(adk-flair-)?v/, "");
    test(`${ref} proceeds with a matching pyproject`, () => {
      const result = runVersion(ref, version);
      expect(result.status, result.text).toBe(0);
      expect(result.version).toBe(version);
    });
  }

  for (const ref of ["v0.59.0", "adk-flair-v0.59.0"]) {
    test(`${ref} refuses a mismatching pyproject and names both versions`, () => {
      const result = runVersion(ref, "0.58.0");
      expect(result.status).toBe(1);
      expect(result.text).toContain("pyproject.toml version is 0.58.0");
      expect(result.text).toContain("expected 0.59.0");
    });
  }

  for (const ref of ["v0.59", "adk-flair-v0.59", "adk-flair-vv0.59.0", "v0.59.0;exit 0"]) {
    test(`${ref} fails semver validation`, () => {
      const result = runVersion(ref, "0.59.0");
      expect(result.status).toBe(1);
      expect(result.text).toContain("Invalid version");
    });
  }

  test("dispatch resolves the input and still requires the pyproject version to match", () => {
    expect(runVersion("main", "0.59.0", "0.59.0").status).toBe(0);
    const mismatch = runVersion("main", "0.58.0", "0.59.0");
    expect(mismatch.status).toBe(1);
    expect(mismatch.text).toContain("pyproject.toml version is 0.58.0");
    expect(mismatch.text).toContain("expected 0.59.0");
    expect(runVersion("main", "0.59.0", "invalid").status).toBe(1);
  });
});
