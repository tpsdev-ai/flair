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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
    const sparse = String(checkout?.with?.["sparse-checkout"]);
    expect(sparse).toContain("scripts/ci");
    // The derivation reads the root package.json and packages/*/package.json, so
    // the sparse checkout must bring them — otherwise lockstep-packages.mjs sees
    // an empty tree and (before the fail-closed fix) an empty package list.
    expect(sparse).toContain("package.json");
    expect(sparse).toContain("packages/*/package.json");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("the version comes from the MARKER PAYLOAD, never from main's package.json", () => {
    const script = job("poll").steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(script).toContain(".payload.package_set_digest");
    expect(script).toContain(".payload.version");
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

describe("release-promote-poll — round 2: derivation, payload version, all pages, main-bound dispatch", () => {
  const runScript = () => (job("poll").steps ?? []).map((s) => s.run ?? "").join("\n");

  test("the package-list derivation FAILS CLOSED: status captured separately, empty is an error, no swallowing substitution", () => {
    const script = runScript();
    // The output and its exit status are captured SEPARATELY.
    expect(script).toContain("pkgs_status=$?");
    expect(script).toContain('if [ "${pkgs_status}" -ne 0 ]');
    expect(script).toContain('if [ ! -s "${PKGS}" ]');
    expect(script).toMatch(/exit 1/);
    // No `< <(node scripts/ci/lockstep-packages.mjs …)` that can swallow a non-zero exit.
    expect(script).not.toContain("< <(node scripts/ci/lockstep-packages.mjs");
  });

  test("the version is the PAYLOAD's and is validated against the ref (a mismatch refuses the marker)", () => {
    const script = runScript();
    expect(script).toContain("payload_version"); // assertion: the payload field is read
    expect(script).toContain('[ "${ref}" != "v${payload_version}" ]'); // assertion: ref must equal v<payload.version>
    expect(script).toContain("refusing this marker"); // assertion: mismatch skips
    expect(script).not.toMatch(/\bversion="\$\{ref#v\}"/); // assertion: never the ref alone
  });

  test("ALL deployment pages are read: the flatten uses add, not .[0]", () => {
    const script = runScript();
    expect(script).toContain("--paginate"); // assertion: every page is fetched
    expect(script).toContain("jq -s 'add"); // assertion: pages are flattened
    expect(script).not.toContain(".[0]"); // assertion: no first-page-only form
  });

  test("BEHAVIOURAL: a marker on page 2 is seen by the flatten (and .[0] would miss it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-pages-"));
    try {
      const p1 = join(dir, "p1.json");
      const p2 = join(dir, "p2.json");
      writeFileSync(p1, JSON.stringify([{ ref: "v0.1.0", payload: { version: "0.1.0" } }]));
      writeFileSync(p2, JSON.stringify([{ ref: "v0.2.0", payload: { version: "0.2.0" } }]));
      const flat = spawnSync("jq", ["-s", "add // [] | map(.ref)", p1, p2], { encoding: "utf8" });
      expect(flat.status, String(flat.stderr)).toBe(0);
      const refs = JSON.parse(flat.stdout) as string[];
      expect(refs).toContain("v0.2.0"); // assertion: the page-2 marker is seen
      const old = spawnSync("jq", ["-s", ".[0] | map(.ref)", p1, p2], { encoding: "utf8" });
      expect(JSON.parse(old.stdout) as string[]).not.toContain("v0.2.0"); // the old bug
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a manual run is refused unless it is on the default branch", () => {
    const first = (job("poll").steps ?? [])[0];
    expect(first, "the guard is the FIRST step").toBeDefined();
    expect(String(first?.if)).toContain("workflow_dispatch"); // assertion: manual runs only
    expect(String(first?.env?.REF)).toBe("${{ github.ref }}");
    expect(String(first?.run)).toContain("refs/heads/"); // assertion: compared to the default branch
    expect(String(first?.run)).toMatch(/exit 1/); // assertion: refuses
  });
});
