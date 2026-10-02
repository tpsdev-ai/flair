import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { tempDir } from "../helpers/temp-dir.ts";

interface Step {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
}

const root = join(import.meta.dir, "..", "..");
const workflow = yaml.load(readFileSync(join(root, ".github/workflows/adk-flair-publish.yml"), "utf8")) as {
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: { version: { required: boolean } } } };
  jobs: { publish: { environment: string; permissions: Record<string, string>; steps: Step[] } };
};
const job = workflow.jobs.publish;
const resolve = job.steps.find(step => step.id === "ver")!;
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
    expect(guard.env?.VERSION).toBe("${{ steps.ver.outputs.version }}");
  });

  test("version and ancestry guards run before the pinned publisher", () => {
    const publishIndex = job.steps.findIndex(step => step.uses?.startsWith("pypa/gh-action-pypi-publish@"));
    expect(publishIndex).toBeGreaterThan(-1);
    expect(job.steps[publishIndex].uses).toMatch(/@[a-f0-9]{40}$/);
    for (const step of [resolve, guard, job.steps.find(step => step.name === "Verify tagged commit is on main")!]) {
      expect(step.run).toBeTruthy();
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
      expect(job.steps.indexOf(step)).toBeLessThan(publishIndex);
    }
    expect(job.steps[publishIndex].if).toBeUndefined();
  });

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
