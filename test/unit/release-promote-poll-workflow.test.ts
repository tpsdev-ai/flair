/**
 * release-promote-poll-workflow.test.ts — flair#1928 slice 1.
 *
 * Shape tests for `.github/workflows/release-promote-poll.yml`, the UNPRIVILEGED
 * poll. It must hold no credential (no environment, no repo secret), must not
 * check out a tag's tree, must read the version from the marker payload, must use
 * an ALL-form readiness predicate, and must never let its outputs decide what gets
 * promoted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}
interface Job {
  name?: string;
  if?: string;
  permissions?: Record<string, string>;
  environment?: string;
  steps?: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..");
const PATH = join(REPO, ".github", "workflows", "release-promote-poll.yml");
const raw = readFileSync(PATH, "utf8");
const wf = yaml.load(raw) as unknown as Workflow;

function job(name: string): Job {
  const found = wf.jobs?.[name];
  expect(found, `job ${name} exists`).toBeDefined();
  return found as Job;
}

describe("release-promote-poll — no credential, trusted-main only", () => {
  test("permissions: {} at the top; the poll job holds actions: write + contents/deployments read only", () => {
    expect(wf.permissions).toEqual({});
    expect(job("poll").permissions).toEqual({
      "actions": "write",
      "contents": "read",
      "deployments": "read",
    });
  });

  test("NO environment, and NO repo secret anywhere in the workflow", () => {
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      expect(j.environment, `job ${name} has no environment`).toBeUndefined();
    }
    // The only credential-shaped value allowed is the auto GITHUB_TOKEN.
    const secretRefs = [...raw.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(secretRefs)]).toEqual(["GITHUB_TOKEN"]);
    expect(raw).not.toContain("NPM_TOKEN");
    // No `environment:` KEY at all (the word in prose is fine).
    expect(/^\s*environment:/m.test(raw), "no environment: key").toBe(false);
  });

  test("it checks out scripts/ci from the DEFAULT BRANCH (github.sha), never a tag ref", () => {
    const checkout = job("poll").steps?.find((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkout, "the poll checks out").toBeDefined();
    expect(String(checkout?.with?.ref)).toBe("${{ github.sha }}");
    expect(String(checkout?.with?.ref)).not.toContain("refs/tags");
    expect(String(checkout?.with?.["sparse-checkout"])).toContain("scripts/ci");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("the version comes from the MARKER PAYLOAD, never from main's package.json", () => {
    const script = job("poll").steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(script).toContain(".payload.package_set_digest");
    expect(script).not.toContain("package.json");
    // Every lockstep package must be public and measurable — ALL-form.
    expect(script).toContain("registry-tarball-sha256.mjs");
    expect(script).toContain("lockstep-packages.mjs");
    expect(script).toContain("NOT READY");
  });

  test("on READY it dispatches release-promote.yml on the tag REF, and the dispatch is gated on the file existing", () => {
    const script = job("poll").steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(script).toContain("gh workflow run release-promote.yml");
    expect(script).toContain("--ref");
    expect(script).toContain("release-promote.yml"); // the existence gate
    expect(script).toContain("would dispatch");
  });

  test("the header says the poll's outputs are never an input to what gets promoted", () => {
    expect(raw).toContain("NEVER an input to what gets promoted");
  });
});
