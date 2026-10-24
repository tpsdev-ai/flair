/**
 * release-promote-workflow.test.ts — flair#1928 slice 2.
 *
 * Shape tests for `.github/workflows/release-promote.yml`, the PRIVILEGED
 * promote, and for the `workflow_call` trigger it adds to `canary.yml`.
 *
 * What this file guards is DEFENCE IN DEPTH inside the workflow, not the
 * boundary. GitHub resolves these workflows at the tag ref. The poll checks
 * tag ruleset properties, its own token's immutable-rule status and the environment
 * tag policy before dispatch (release-promote-poll-workflow.test.ts). For a tag
 * whose copy is the reviewed one: no job runs a REPOSITORY script from the tag's checkout (after a failed
 * tree selection, none runs at all), every executed repository file equals
 * `origin/main`'s copy, and every fact the promote acts on is re-read, validated
 * and fails closed when it cannot be. (The canary does run the published
 * packages it installs: that is its test.) The guard tests run the CURRENT
 * guard against tampered git trees, never a tampered workflow definition.
 * The static tests pin the shape. The behavioural tests extract the real `run:`
 * scripts from the YAML and drive them: the derive and emit refusals with
 * fixtures; the guard, the materialisation, prepare's pin and the canary's tree
 * selection against real git repositories (matching and tampered trees); and the
 * token step with the real npm CLI against a local registry stub.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import yaml from "js-yaml";
import { canaryScriptClosure } from "../helpers/canary-script-closure";

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
  outputs?: Record<string, string>;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  environment?: string;
  env?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  "run-name"?: string;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  on?: Record<string, unknown>;
  true?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..");
const WF_PATH = join(REPO, ".github", "workflows", "release-promote.yml");
const CANARY_PATH = join(REPO, ".github", "workflows", "canary.yml");
const raw = readFileSync(WF_PATH, "utf8");
const wf = yaml.load(raw) as unknown as Workflow;
const canaryRaw = readFileSync(CANARY_PATH, "utf8");
const canaryWf = yaml.load(canaryRaw) as unknown as Workflow;

function job(name: string): Job {
  const found = wf.jobs?.[name];
  expect(found, `job ${name} exists`).toBeDefined();
  return found as Job;
}
function runOf(name: string, stepId: string): string {
  const step = (job(name).steps ?? []).find((s) => s.id === stepId);
  expect(step, `step #${stepId} in job ${name} exists`).toBeDefined();
  return step?.run ?? "";
}
/** The guard's compare list: the words between `for f in \` and `; do`. */
function guardList(): string[] {
  const m = runOf("promote", "guard").match(/for f in \\\n([\s\S]*?); do/);
  expect(m, "the guard's for-list is present").not.toBeNull();
  return m![1]!.split(/[\s\\]+/).filter(Boolean);
}
/** The workflow triggers, whichever spelling js-yaml produced for the bare `on` key. */
function triggers(doc: Workflow): Record<string, unknown> {
  return (doc.on ?? doc.true ?? {}) as Record<string, unknown>;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "promote-wf-"));
  tmpDirs.push(dir);
  return dir;
}

describe("release-promote — the privileged job's credential and boundary", () => {
  test("permissions: {} at the top; each job opts into read-only grants", () => {
    expect(wf.permissions).toEqual({});
    expect(job("prepare").permissions).toEqual({ contents: "read", deployments: "read" });
    expect(job("promote").permissions).toEqual({ contents: "read", deployments: "read" });
  });

  test("the canary call's grant is its EFFECTIVE boundary: contents: read, and canary.yml asks for nothing more", () => {
    // A called workflow can never hold more than the calling job grants; with the
    // top level at {} and no grant on the call, canary.yml's checkout had nothing.
    const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };
    const grant = job("canary").permissions ?? {};
    expect(grant).toEqual({ contents: "read" });
    expect(canaryWf.permissions).toEqual({});
    const jobs = Object.entries(canaryWf.jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);
    for (const [name, j] of jobs) {
      expect(j.permissions, `canary.yml job ${name} declares its permissions`).toBeDefined();
      for (const [scope, level] of Object.entries(j.permissions ?? {})) {
        expect(LEVEL[level] ?? 99, `canary.yml ${name}: ${scope}: ${level} is within the caller's grant`).toBeLessThanOrEqual(
          LEVEL[grant[scope] ?? "none"] ?? 0,
        );
      }
      // checkout is the one thing it needs, and the grant carries it.
      expect(j.permissions?.contents).toBe("read");
    }
  });

  test("only the promote job takes the release-promote environment", () => {
    expect(job("promote").environment).toBe("release-promote");
    expect(job("prepare").environment).toBeUndefined();
    expect(job("canary").environment).toBeUndefined();
    expect((canaryWf.jobs?.canary as Job | undefined)?.environment).toBeUndefined();
  });

  test("NPM_TOKEN is referenced in exactly ONE step, and no job-level env carries it", () => {
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      const jobEnv = JSON.stringify(j.env ?? {});
      expect(jobEnv, `job ${name} has no job-level NPM_TOKEN`).not.toContain("NPM_TOKEN");
    }
    // The secret reference appears once in the whole file, in the promote job's
    // final step, whose env is the only one that names NPM_TOKEN.
    const secretRefs = [...raw.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(secretRefs).toEqual(["NPM_TOKEN"]);
    const steps = job("promote").steps ?? [];
    const withToken = steps.filter((s) => JSON.stringify(s.env ?? {}).includes("NPM_TOKEN"));
    expect(withToken.length).toBe(1);
    expect(withToken[0], "the token step is the LAST step of the promote job").toBe(steps[steps.length - 1]);
    expect(withToken[0]?.name).toContain("NPM_TOKEN");
    // The token reaches npm only through the throwaway .npmrc indirection, never
    // as a command argument.
    expect(withToken[0]?.run ?? "").toContain("_authToken=${NPM_TOKEN}");
    expect(withToken[0]?.run ?? "").not.toContain("--otp");
  });

  test("no job executes a repository script from the tag's checkout", () => {
    const runsScript = (st: Step) => /scripts\//.test(st.run ?? "");
    // prepare: the step that moves the workspace to the pinned origin/main precedes
    // every step that runs a repository script.
    const prep = job("prepare").steps ?? [];
    const pin = prep.findIndex((st) => st.id === "trusted");
    expect(pin).toBeGreaterThan(0);
    expect(prep[pin]?.run ?? "").toContain('git checkout --quiet --detach "$MAIN_SHA"');
    prep.forEach((st, i) => {
      if (runsScript(st)) expect(i, `prepare step '${st.name}' runs after the pin`).toBeGreaterThan(pin);
    });
    expect(prep.some(runsScript), "prepare runs a script (positive control)").toBe(true);
    // canary.yml: the tree selection comes right after checkout, before every
    // step that runs a repository script, and the call passes prepare's pin.
    const cSteps = canaryWf.jobs?.canary?.steps ?? [];
    expect(cSteps[0]?.uses ?? "").toContain("actions/checkout@");
    expect(cSteps[1]?.name ?? "").toStartWith("Select the executed tree");
    cSteps.forEach((st, i) => {
      if (runsScript(st)) expect(i, `canary step '${st.name}' runs after the tree selection`).toBeGreaterThan(1);
    });
    expect(job("canary").with?.trusted_sha).toBe("${{ needs.prepare.outputs.trusted_sha }}");
    expect(job("prepare").outputs?.trusted_sha).toBe("${{ steps.trusted.outputs.trusted_sha }}");
    // promote: every step that runs a script does so from the trusted tree.
    for (const id of ["derive", "emit"]) {
      const r = runOf("promote", id);
      expect(r.indexOf('cd "$TRUSTED"'), `${id} enters the trusted tree`).toBeGreaterThanOrEqual(0);
      expect(r.indexOf('cd "$TRUSTED"'), `${id} enters the trusted tree before any script`).toBeLessThan(r.indexOf("scripts/"));
    }
  });

  test("no step that can see the token runs a path from the tag checkout", () => {
    // The token step runs only the trusted block, from the trusted tree.
    const tokenRun = (job("promote").steps ?? [])
      .filter((s) => JSON.stringify(s.env ?? {}).includes("NPM_TOKEN"))
      .map((s) => s.run ?? "")
      .join("\n");
    expect(tokenRun).toContain('cd "$TRUSTED"');
    expect(tokenRun).not.toContain("$GITHUB_WORKSPACE");
    // The trusted tree is materialised from the pinned origin/main sha, not from
    // the tag's checkout.
    const materialise = (job("promote").steps ?? []).find((s) => s.name?.includes("trusted tree"));
    expect(materialise, "the trusted tree step exists").toBeDefined();
    expect(materialise?.run ?? "").toContain("git archive");
    expect(materialise?.run ?? "").toContain("MAIN_SHA");
    expect(materialise?.run ?? "").toContain("TRUSTED=${TRUSTED}");
  });

  test("the machinery-recency guard runs first and pins origin/main", () => {
    const steps = job("promote").steps ?? [];
    const guard = steps.find((s) => s.id === "guard");
    expect(guard, "the guard step exists").toBeDefined();
    expect(guard?.run ?? "").toContain("git fetch --no-tags origin main");
    expect(guard?.run ?? "").toContain("merge-base --is-ancestor");
    expect(steps.findIndex((s) => s.id === "guard"), "the guard is the first step after checkout").toBe(1);
  });

  test("the guard compares EVERY executed file: both workflow definitions, the canary's script closure, this workflow's scripts", () => {
    // Derived, not listed: the canary's closure is walked from canary.yml (the
    // same walk as the dependency-free guard), so a new canary helper that is not
    // compared turns this red.
    const closure = canaryScriptClosure();
    const own = [...raw.matchAll(/\b(?:node|bash)\s+(scripts\/[A-Za-z0-9._/-]+\.(?:mjs|sh))/g)].map((m) => m[1]!);
    expect(own).toContain("scripts/ci/canary-verdict.sh");
    const expected = new Set([
      ".github/workflows/release-promote.yml",
      ".github/workflows/canary.yml",
      ...closure.shellScripts,
      ...closure.modules,
      ...own,
    ]);
    expect(expected.has("scripts/ci/check-instance-boot.sh")).toBe(true);
    expect(expected.has("scripts/ci/check-plugin-canary.mjs")).toBe(true);
    expect([...new Set(guardList())].sort()).toEqual([...expected].sort());
  });
});

describe("release-promote — the machine surface and the canary order", () => {
  test("the canary is called (workflow_call) and the promote needs it", () => {
    expect(job("canary").uses).toBe("./.github/workflows/canary.yml");
    expect(job("canary").needs).toBe("prepare");
    expect(job("promote").needs).toBe("canary");
    // The called workflow takes the manual dispatch's three inputs plus the
    // REQUIRED trusted_sha (a call can never fall back to the caller's tree).
    const call = triggers(canaryWf)["workflow_call"] as { inputs?: Record<string, { required?: boolean }> } | undefined;
    expect(call, "canary.yml accepts a workflow_call").toBeDefined();
    expect(Object.keys(call?.inputs ?? {}).sort()).toEqual([
      "expected_sha256",
      "package_set_digest",
      "trusted_sha",
      "version",
    ]);
    expect(call?.inputs?.trusted_sha?.required).toBe(true);
    expect(triggers(canaryWf)["workflow_dispatch"]).toBeDefined();
  });

  test("the promote block comes from `--emit bash`, never from scraping the markdown", () => {
    const emit = runOf("promote", "emit");
    expect(emit).toContain("canary-verdict.sh");
    expect(emit).toContain("--emit bash");
    expect(emit).toContain('cd "$TRUSTED"');
    // No fence-scraping: the block is not extracted from the human verdict text.
    expect(raw).not.toContain("sed -n");
  });
});

describe("release-promote — every re-derivation fails closed", () => {
  test("static shape: the version, ancestry, marker and digest checks each exist with a named refusal", () => {
    const derive = runOf("promote", "derive");
    expect(derive).toContain("GITHUB_REF_NAME");
    expect(derive).toContain("is not an exact v<major>.<minor>.<patch> release tag");
    expect(derive).toContain("no release-attempt marker for v");
    expect(derive).toContain("does not match the ref's");
    expect(derive).toContain("no valid package_set_digest");
    expect(derive).toContain("not the certified set");
    // The lockstep derivation is captured with its exit status separately.
    expect(derive).toContain('if ! node scripts/ci/lockstep-packages.mjs > "$PKGS"');
    expect(derive).not.toContain("< <(node scripts/ci/lockstep-packages.mjs");
  });

  test("the dry-run input defaults to true and gates only the dist-tag step", () => {
    const on = triggers(wf) as { workflow_dispatch?: { inputs?: Record<string, { default?: unknown; type?: string }> } };
    const dry = on.workflow_dispatch?.inputs?.dry_run;
    expect(dry?.type).toBe("boolean");
    expect(dry?.default).toBe(true);
    const steps = job("promote").steps ?? [];
    const tokenStep = steps[steps.length - 1];
    expect(tokenStep?.if).toContain("inputs.dry_run == false");
    const dryStep = steps.find((s) => s.name?.includes("Dry run"));
    expect(dryStep?.if).toContain("inputs.dry_run == true");
  });

  test("the run-name distinguishes dry runs from real promotions", () => {
    expect(wf["run-name"]).toBe("release-promote ${{ github.ref_name }}${{ inputs.dry_run && ' (dry run)' || '' }}");
  });
});

// ── Behavioural: drive the real `derive` step with fixtures ──────────────────
//
// The step's `run:` is extracted verbatim and executed, with a FAKE `gh` (an
// external network service, exempt from the real-component rule) and a fixture
// trusted tree. The registry hasher is stubbed (it would hit the network), but
// the lockstep-package and package-set-digest scripts are the REAL repo files, so
// the digest comparison is exercised end to end.

/** sha256 over `<name>@<version> <sha>\n` lines, byte-sorted — the canonical form. */
function canonicalDigest(version: string, lines: Record<string, string>): string {
  const rows = Object.entries(lines)
    .map(([pkg, sha]) => `${pkg}@${version} ${sha}\n`)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return createHash("sha256").update(rows.join("")).digest("hex");
}

interface DeriveFixture {
  refName: string;
  deployments: unknown[];
  stubFailPkg?: string;
  /** `ok` (the real script) | `empty` (exit 0, no output) | `fail` (exit 2). */
  lockstep?: "ok" | "empty" | "fail";
}

function runDerive(fx: DeriveFixture) {
  const dir = scratch();
  const trusted = join(dir, "trusted");
  mkdirSync(join(trusted, "scripts", "ci"), { recursive: true });
  copyFileSync(
    join(REPO, "scripts", "ci", "lockstep-packages.mjs"),
    join(trusted, "scripts", "ci", "lockstep-packages.mjs"),
  );
  copyFileSync(
    join(REPO, "scripts", "ci", "package-set-digest.mjs"),
    join(trusted, "scripts", "ci", "package-set-digest.mjs"),
  );
  writeFileSync(
    join(trusted, "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.0.0" }),
  );
  mkdirSync(join(trusted, "packages", "client"), { recursive: true });
  writeFileSync(
    join(trusted, "packages", "client", "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/client", version: "0.0.0" }),
  );
  if (fx.lockstep && fx.lockstep !== "ok") {
    // Replace the real derivation so the step's own fail-closed branch is driven
    // without depending on a malformed-manifest fixture.
    const exit = fx.lockstep === "fail" ? 2 : 0;
    writeFileSync(
      join(trusted, "scripts", "ci", "lockstep-packages.mjs"),
      `#!/usr/bin/env node\nif (${exit} !== 0) console.error("DID NOT RUN");\nprocess.exit(${exit});\n`,
    );
  }
  // Stub registry hasher: a deterministic sha per <version> <pkg>, with the
  // failure modes the step must refuse on.
  writeFileSync(
    join(trusted, "scripts", "ci", "registry-tarball-sha256.mjs"),
    `#!/usr/bin/env node
import { createHash } from "node:crypto";
const [version, pkg] = process.argv.slice(2);
if (process.env.STUB_FAIL_PKG && pkg === process.env.STUB_FAIL_PKG) process.exit(3);
process.stdout.write(createHash("sha256").update(version + "\\n" + pkg).digest("hex") + "\\n");
`,
  );

  const ghDir = join(dir, "bin");
  mkdirSync(ghDir, { recursive: true });
  const deploymentsFile = join(dir, "deployments.json");
  writeFileSync(deploymentsFile, JSON.stringify(fx.deployments));
  const ghPath = join(ghDir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
if [[ "$*" == *deployments* ]]; then cat "$FAKE_DEPLOYMENTS"; exit 0; fi
echo "fake gh: unhandled $*" >&2; exit 1
`,
  );
  chmodSync(ghPath, 0o755);
  const runnerTemp = join(dir, "runner");
  mkdirSync(runnerTemp, { recursive: true });
  const outFile = join(dir, "github-output");
  writeFileSync(outFile, "");

  const script = join(dir, "derive.sh");
  writeFileSync(script, runOf("promote", "derive"));

  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${ghDir}:${process.env.PATH}`,
      GITHUB_REF_NAME: fx.refName,
      GITHUB_REPOSITORY: "octo/repo",
      GITHUB_OUTPUT: outFile,
      RUNNER_TEMP: runnerTemp,
      TRUSTED: trusted,
      GH_TOKEN: "x",
      FAKE_DEPLOYMENTS: deploymentsFile,
      ...(fx.stubFailPkg ? { STUB_FAIL_PKG: fx.stubFailPkg } : {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", log: (r.stdout ?? "") + (r.stderr ?? ""), out: readFileSync(outFile, "utf8") };
}

describe("release-promote — the derive step refuses on every unmeasurable input (behavioural)", () => {
  const sha = (pkg: string) => createHex("1.2.3\n" + pkg);
  function createHex(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }
  const goodDigest = () =>
    canonicalDigest("1.2.3", {
      "@tpsdev-ai/client": sha("@tpsdev-ai/client"),
      "@tpsdev-ai/flair": sha("@tpsdev-ai/flair"),
    });
  const marker = (psd: string, version = "1.2.3") => [
    { ref: "v1.2.3", payload: { version, package_set_digest: psd } },
  ];

  test("a prerelease ref is refused before anything else", () => {
    const r = runDerive({ refName: "v1.2.3-rc.1", deployments: marker(goodDigest()) });
    expect(r.status).toBe(1);
    expect(r.log).toContain("is not an exact v<major>.<minor>.<patch> release tag");
  });

  test("a missing release-attempt marker is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: [] });
    expect(r.status).toBe(1);
    expect(r.log).toContain("no release-attempt marker for v1.2.3");
  });

  test("a marker whose payload version disagrees with the ref is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker(goodDigest(), "9.9.9") });
    expect(r.status).toBe(1);
    expect(r.log).toContain("does not match the ref's");
  });

  test("a non-hex marker digest is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker("not-a-digest") });
    expect(r.status).toBe(1);
    expect(r.log).toContain("no valid package_set_digest");
  });

  test("an unmeasurable tarball is refused, never hashed into a match", () => {
    const r = runDerive({
      refName: "v1.2.3",
      deployments: marker("a".repeat(64)),
      stubFailPkg: "@tpsdev-ai/client",
    });
    expect(r.status).toBe(1);
    expect(r.log).toContain("unmeasurable is not a pass");
  });

  test("an empty lockstep list is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker(goodDigest()), lockstep: "empty" });
    expect(r.status).toBe(1);
    expect(r.log).toContain("lockstep package list is empty");
  });

  test("a failed lockstep derivation is refused, never read as an empty set", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker(goodDigest()), lockstep: "fail" });
    expect(r.status).toBe(1);
    expect(r.log).toContain("lockstep package-list derivation failed");
  });

  test("a digest that is not the certified set is refused", () => {
    const r = runDerive({ refName: "v1.2.3", deployments: marker("b".repeat(64)) });
    expect(r.status).toBe(1);
    expect(r.log).toContain("not the certified set");
  });

  test("the certified set passes and the outputs carry the version and digest", () => {
    const psd = goodDigest();
    const r = runDerive({ refName: "v1.2.3", deployments: marker(psd) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toContain("version=1.2.3");
    expect(r.out).toContain(`certified_digest=${psd}`);
  });
});

// ── Behavioural: real git — the guard, the materialisation, the pins ─────────
//
// Each case builds a throwaway origin (bare) + a runner workspace cloned from it
// and checked out at the tag, exactly what `actions/checkout` with fetch-depth 0
// leaves, then runs the step's real `run:` there. git is hermetic: no global or
// system config, no inherited GIT_* variable.

const GIT_ENV: Record<string, string> = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.startsWith("GIT_") && v !== undefined),
  ) as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

const BOOT = "scripts/ci/check-instance-boot.sh";
const PLUGIN = "scripts/ci/check-plugin-canary.mjs";
const HASHER = "scripts/ci/registry-tarball-sha256.mjs";
/** The machinery, runnable where a step runs it; `who` marks whose tree ran. */
function machinery(who: "HONEST" | "TAMPERED"): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of guardList()) files[f] = `# ${who} ${f}\n`;
  files[BOOT] = `#!/usr/bin/env bash\necho "${who} boot"\nexit 0\n`;
  files[PLUGIN] = `console.log("[plugin-canary] ${who} plugin");\nprocess.exit(0);\n`;
  files[HASHER] = `process.stdout.write("${who === "HONEST" ? "a" : "b"}".repeat(64) + "\\n");\n`;
  return files;
}

interface GitFixture {
  dir: string;
  src: string;
  origin: string;
}
function writeTree(root: string, files: Record<string, string | null>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
    if (rel.endsWith(".sh")) chmodSync(full, 0o755);
  }
}
function gitFixture(): GitFixture {
  const dir = scratch();
  const src = join(dir, "src");
  const origin = join(dir, "origin.git");
  mkdirSync(src);
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(src, "init", "-q", "-b", "main");
  writeTree(src, { "README.md": "fixture\n", ...machinery("HONEST") });
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "c0");
  git(src, "remote", "add", "origin", origin);
  git(src, "push", "-q", "origin", "main");
  return { dir, src, origin };
}
/** Commit `files` on the source's current branch, push it, return the sha. */
function commitPush(fx: GitFixture, files: Record<string, string | null>, ref = "main"): string {
  writeTree(fx.src, files);
  git(fx.src, "add", "-A");
  git(fx.src, "commit", "-q", "-m", `change ${Object.keys(files).join(",")}`);
  const sha = git(fx.src, "rev-parse", "HEAD");
  git(fx.src, "push", "-q", "origin", `HEAD:${ref}`);
  return sha;
}
function tag(fx: GitFixture, name: string, sha: string) {
  git(fx.src, "tag", name, sha);
  git(fx.src, "push", "-q", "origin", `refs/tags/${name}`);
}
/** A runner workspace: a clone of origin, checked out (detached) at `sha`. */
function workspaceAt(fx: GitFixture, sha: string): string {
  const ws = mkdtempSync(join(fx.dir, "ws-"));
  rmSync(ws, { recursive: true, force: true });
  git(fx.dir, "clone", "-q", fx.origin, ws);
  git(ws, "checkout", "-q", "--detach", sha);
  return ws;
}
/** Run a step's `run:` as GitHub does (bash -e -o pipefail), in `cwd`. */
function runStep(script: string, cwd: string, env: Record<string, string>) {
  const dir = scratch();
  const file = join(dir, "step.sh");
  writeFileSync(file, script);
  const out = join(dir, "github-output");
  const genv = join(dir, "github-env");
  writeFileSync(out, "");
  writeFileSync(genv, "");
  mkdirSync(join(dir, "runner"), { recursive: true });
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...GIT_ENV, GITHUB_OUTPUT: out, GITHUB_ENV: genv, RUNNER_TEMP: join(dir, "runner"), ...env },
  });
  return {
    status: r.status,
    log: (r.stdout ?? "") + (r.stderr ?? ""),
    out: readFileSync(out, "utf8"),
    genv: readFileSync(genv, "utf8"),
  };
}
function canaryStep(pred: (s: Step) => boolean): string {
  const st = (canaryWf.jobs?.canary?.steps ?? []).find(pred);
  expect(st, "the canary step exists").toBeDefined();
  return st?.run ?? "";
}

describe("release-promote — the machinery-recency guard and the materialisation (real git; defence in depth)", () => {
  test("a matching tag passes; the trusted tree is origin/main's, never the workspace's", () => {
    const fx = gitFixture();
    const tagSha = git(fx.src, "rev-parse", "HEAD");
    tag(fx, "v1.2.3", tagSha);
    const mainSha = commitPush(fx, { "README.md": "main moved on\n" });
    const ws = workspaceAt(fx, tagSha);
    const g = runStep(runOf("promote", "guard"), ws, { GITHUB_SHA: tagSha });
    expect(g.status, g.log).toBe(0);
    expect(g.out).toContain(`main_sha=${mainSha}`);
    // Even a workspace file that differs (the guard would refuse it) cannot reach
    // the trusted tree: it is `git archive` of the pinned sha.
    writeFileSync(join(ws, "scripts/ci/canary-verdict.sh"), "# TAMPERED in the workspace\n");
    const runnerDir = scratch();
    const materialise = (job("promote").steps ?? []).find((s) => s.name?.startsWith("Materialise the trusted tree"));
    expect(materialise, "the materialisation step exists").toBeDefined();
    const m = runStep(materialise?.run ?? "", ws, { MAIN_SHA: mainSha, RUNNER_TEMP: runnerDir });
    expect(m.status, m.log).toBe(0);
    const trusted = join(runnerDir, "trusted");
    expect(m.genv).toContain(`TRUSTED=${trusted}`);
    expect(readFileSync(join(trusted, "README.md"), "utf8")).toBe("main moved on\n");
    expect(readFileSync(join(trusted, "scripts/ci/canary-verdict.sh"), "utf8")).toBe(
      "# HONEST scripts/ci/canary-verdict.sh\n",
    );
  });

  test.each([BOOT, PLUGIN, "scripts/ci/canary-verdict.sh", ".github/workflows/canary.yml"])(
    "a tag whose %s was tampered (main since reverted) is refused",
    (path) => {
      const fx = gitFixture();
      const tampered = commitPush(fx, { [path]: machinery("TAMPERED")[path]! });
      tag(fx, "v1.2.4", tampered);
      commitPush(fx, { [path]: machinery("HONEST")[path]! });
      const ws = workspaceAt(fx, tampered);
      const g = runStep(runOf("promote", "guard"), ws, { GITHUB_SHA: tampered });
      expect(g.status).toBe(1);
      expect(g.log).toContain(`'${path}' at the tag differs from origin/main`);
    },
  );

  test("a tag that is not on origin/main, or that lacks a machinery file, is refused", () => {
    const fx = gitFixture();
    const side = commitPush(fx, { "README.md": "side\n" }, "side");
    const ws = workspaceAt(fx, side);
    const g = runStep(runOf("promote", "guard"), ws, { GITHUB_SHA: side });
    expect(g.status).toBe(1);
    expect(g.log).toContain("is not an ancestor of origin/main");

    const fx2 = gitFixture();
    const without = commitPush(fx2, { [BOOT]: null });
    commitPush(fx2, { [BOOT]: machinery("HONEST")[BOOT]! });
    const ws2 = workspaceAt(fx2, without);
    const g2 = runStep(runOf("promote", "guard"), ws2, { GITHUB_SHA: without });
    expect(g2.status).toBe(1);
    expect(g2.log).toContain(`'${BOOT}' is absent from the tag's tree`);
  });
});

describe("release-promote — prepare pins origin/main and runs its hasher from it (real git)", () => {
  test("the workspace moves from the tampered tag to origin/main before the hasher runs", () => {
    const fx = gitFixture();
    const tampered = commitPush(fx, { [HASHER]: machinery("TAMPERED")[HASHER]! });
    tag(fx, "v1.2.4", tampered);
    const mainSha = commitPush(fx, { [HASHER]: machinery("HONEST")[HASHER]! });
    const ws = workspaceAt(fx, tampered);
    const pin = runStep(runOf("prepare", "trusted"), ws, { GITHUB_SHA: tampered });
    expect(pin.status, pin.log).toBe(0);
    expect(pin.out).toContain(`trusted_sha=${mainSha}`);
    expect(git(ws, "rev-parse", "HEAD")).toBe(mainSha);
    const h = runStep(runOf("prepare", "flair_sha"), ws, { VERSION: "1.2.4" });
    expect(h.status, h.log).toBe(0);
    expect(h.out).toContain(`expected_sha256=${"a".repeat(64)}`); // main's hasher, not the tag's "b…"
  });

  test("a tag that is not on origin/main is refused before any pin", () => {
    const fx = gitFixture();
    const side = commitPush(fx, { "README.md": "side\n" }, "side");
    const ws = workspaceAt(fx, side);
    const pin = runStep(runOf("prepare", "trusted"), ws, { GITHUB_SHA: side });
    expect(pin.status).toBe(1);
    expect(pin.log).toContain("is not an ancestor of origin/main");
    expect(pin.out).not.toContain("trusted_sha=");
  });
});

describe("canary.yml — a release-promote call runs trusted main's scripts, never the tag's (real git; defence in depth)", () => {
  const select = () => canaryStep((s) => (s.name ?? "").startsWith("Select the executed tree"));
  const CALLED = "octo/repo/.github/workflows/release-promote.yml@refs/tags/v1.2.4";
  const MANUAL = "octo/repo/.github/workflows/canary.yml@refs/heads/main";

  /** A tag whose boot AND plugin-check scripts were tampered; main reverted both. */
  function tamperedTag() {
    const fx = gitFixture();
    const t = machinery("TAMPERED");
    const tampered = commitPush(fx, { [BOOT]: t[BOOT]!, [PLUGIN]: t[PLUGIN]! });
    tag(fx, "v1.2.4", tampered);
    const h = machinery("HONEST");
    const mainSha = commitPush(fx, { [BOOT]: h[BOOT]!, [PLUGIN]: h[PLUGIN]! });
    return { fx, tampered, mainSha, ws: workspaceAt(fx, tampered) };
  }
  /** Run the canary's real boot and plugin steps in `ws`; return their logs. */
  function bootAndPlugin(ws: string) {
    const prefix = join(scratch(), "prefix");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(prefix, "bin", "flair"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(prefix, "bin", "flair"), 0o755);
    const boot = runStep(canaryStep((s) => s.id === "boot"), ws, { PREFIX: prefix });
    expect(boot.status, boot.log).toBe(0);
    const plugin = runStep(canaryStep((s) => s.id === "plugin"), ws, {
      PREFIX: prefix,
      VERSION: "1.2.4",
      BOOT_OUTCOME: "success",
      HOME: scratch(),
    });
    expect(plugin.status, plugin.log).toBe(0);
    return {
      boot: readFileSync(join(ws, "canary-logs", "boot.log"), "utf8"),
      plugin: readFileSync(join(ws, "canary-logs", "plugin.log"), "utf8"),
    };
  }

  test("control: without the selection, the tag's tampered boot and plugin checks are what run", () => {
    const { ws } = tamperedTag();
    const logs = bootAndPlugin(ws);
    expect(logs.boot).toContain("TAMPERED boot");
    expect(logs.plugin).toContain("TAMPERED plugin");
  });

  test("a call moves the workspace to trusted_sha first: main's honest checks run, the tampered tag's do not", () => {
    const { ws, mainSha } = tamperedTag();
    const s = runStep(select(), ws, { TRUSTED_SHA: mainSha, RUN_WORKFLOW_REF: CALLED });
    expect(s.status, s.log).toBe(0);
    expect(git(ws, "rev-parse", "HEAD")).toBe(mainSha);
    const logs = bootAndPlugin(ws);
    expect(logs.boot).toContain("HONEST boot");
    expect(logs.boot).not.toContain("TAMPERED");
    expect(logs.plugin).toContain("HONEST plugin");
    expect(logs.plugin).not.toContain("TAMPERED");
  });

  test("a call without a trusted_sha, or with one that is malformed or off main, is refused", () => {
    const { fx, ws, tampered } = tamperedTag();
    const none = runStep(select(), ws, { TRUSTED_SHA: "", RUN_WORKFLOW_REF: CALLED });
    expect(none.status).toBe(1);
    expect(none.log).toContain("without a trusted_sha");
    const bad = runStep(select(), ws, { TRUSTED_SHA: "main", RUN_WORKFLOW_REF: CALLED });
    expect(bad.status).toBe(1);
    expect(bad.log).toContain("is not a 40-hex commit sha");
    const side = commitPush(fx, { "README.md": "side\n" }, "side");
    const off = runStep(select(), ws, { TRUSTED_SHA: side, RUN_WORKFLOW_REF: CALLED });
    expect(off.status).toBe(1);
    expect(off.log).toContain("is not on origin/main");
    expect(git(ws, "rev-parse", "HEAD")).toBe(tampered);
  });

  test("a file left over from the caller's checkout is refused (the workspace must BE trusted_sha)", () => {
    const { ws, mainSha } = tamperedTag();
    writeFileSync(join(ws, "leftover.sh"), "echo planted\n");
    const s = runStep(select(), ws, { TRUSTED_SHA: mainSha, RUN_WORKFLOW_REF: CALLED });
    expect(s.status).toBe(1);
    expect(s.log).toContain(`the workspace is not exactly ${mainSha}`);
  });

  test("a manual dispatch keeps its dispatch ref's tree (unchanged path)", () => {
    const { ws, tampered } = tamperedTag();
    const s = runStep(select(), ws, { TRUSTED_SHA: "", RUN_WORKFLOW_REF: MANUAL });
    expect(s.status, s.log).toBe(0);
    expect(git(ws, "rev-parse", "HEAD")).toBe(tampered);
  });
});

// ── Behavioural: the emit step and the token step (real npm, local registry) ──

const VER = "1.2.3";
const CLIENT = "@tpsdev-ai/flair-client";
const FLAIR = "@tpsdev-ai/flair";
/** A trusted tree holding the REAL promote machinery and a two-package lockstep set. */
function trustedTree(): string {
  const t = join(scratch(), "trusted");
  mkdirSync(join(t, "scripts", "ci"), { recursive: true });
  for (const f of [
    "canary-verdict.sh",
    "lockstep-packages.mjs",
    "package-set-digest.mjs",
    "registry-tarball-sha256.mjs",
    "registry-latest-skew.mjs",
  ]) {
    copyFileSync(join(REPO, "scripts", "ci", f), join(t, "scripts", "ci", f));
  }
  chmodSync(join(t, "scripts", "ci", "canary-verdict.sh"), 0o755);
  writeFileSync(join(t, "package.json"), JSON.stringify({ name: FLAIR, version: VER }));
  mkdirSync(join(t, "packages", "client"), { recursive: true });
  writeFileSync(join(t, "packages", "client", "package.json"), JSON.stringify({ name: CLIENT, version: VER }));
  return t;
}
function emitIn(trusted: string, digest: string) {
  return runStep(runOf("promote", "emit"), REPO, {
    TRUSTED: trusted,
    VERSION: VER,
    CERTIFIED_DIGEST: digest,
    RUN_URL: "https://github.com/octo/repo/actions/runs/1",
  });
}

describe("release-promote — the emit step refuses when the machine surface yields no block", () => {
  test("canary-verdict.sh refusing (exit 3: no valid digest) is a named refusal", () => {
    const r = emitIn(trustedTree(), "not-a-digest");
    expect(r.status).toBe(1);
    expect(r.log).toContain("canary-verdict.sh --emit bash produced no promote block");
    expect(r.out).not.toContain("promote_block=");
  });

  test("an empty block (exit 0, no bytes) is a named refusal", () => {
    const t = trustedTree();
    writeFileSync(join(t, "scripts", "ci", "canary-verdict.sh"), "#!/usr/bin/env bash\nexit 0\n");
    const r = emitIn(t, "c".repeat(64));
    expect(r.status).toBe(1);
    expect(r.log).toContain("the emitted promote block is empty");
  });

  test("a valid digest yields the block, byte-identical to the script's own --emit bash", () => {
    const t = trustedTree();
    const r = emitIn(t, "c".repeat(64));
    expect(r.status, r.log).toBe(0);
    const path = /promote_block=(.+)/.exec(r.out)?.[1] ?? "";
    const direct = spawnSync("bash", ["scripts/ci/canary-verdict.sh", "pass", VER, "https://github.com/octo/repo/actions/runs/1", "--package-set-digest", "c".repeat(64), "--emit", "bash"], { cwd: t, encoding: "utf8" });
    expect(direct.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(direct.stdout);
  });
});

test("the token step reports an observation only after the block succeeds", () => {
  const dir = scratch();
  const block = join(dir, "block.sh");
  const steps = job("promote").steps ?? [];
  const script = steps[steps.length - 1]?.run ?? "";
  const env = { NPM_TOKEN: "fixture-token", VERSION: VER, BLOCK: block, TRUSTED: dir };
  writeFileSync(block, "exit 0\n");
  const success = runStep(script, dir, env);
  expect(success.status, success.log).toBe(0);
  expect(success.log).toContain(`the convergence check observed latest at ${VER} for every lockstep package`);
  expect(success.log).not.toContain("latest now points at");
  writeFileSync(block, "exit 1\n");
  const failure = runStep(script, dir, env);
  expect(failure.status).toBe(1);
  expect(failure.log).not.toContain("the convergence check observed");
});

interface RegistryRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
}
/**
 * A LOCAL npm registry stub (127.0.0.1, ephemeral port; no network): packuments,
 * tarballs, and the dist-tags endpoints `npm dist-tag ls|add` use. Every request
 * is recorded with its Authorization header.
 */
async function localRegistry(latest: Record<string, string>, opts: { failPutFor?: string } = {}) {
  const tarballs: Record<string, Buffer> = {};
  for (const p of Object.keys(latest)) tarballs[p] = Buffer.from(`tarball bytes of ${p}@${VER}\n`);
  const requests: RegistryRequest[] = [];
  let base = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://stub").pathname);
      requests.push({ method: req.method ?? "", path, auth: req.headers.authorization, body });
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      let m: RegExpMatchArray | null;
      if (req.method === "PUT" && (m = path.match(/^\/-\/package\/(.+)\/dist-tags\/([^/]+)$/))) {
        if (m[1] === opts.failPutFor) return send(403, { error: "forbidden" });
        latest[m[1]!] = JSON.parse(body) as string;
        return send(201, { ok: true });
      }
      if (req.method === "GET" && (m = path.match(/^\/-\/package\/(.+)\/dist-tags$/))) {
        return m[1]! in latest ? send(200, { latest: latest[m[1]!] }) : send(404, { error: "not found" });
      }
      if (req.method === "GET" && (m = path.match(/^\/tgz\/(.+)$/))) {
        const buf = tarballs[m[1]!];
        if (!buf) return send(404, { error: "not found" });
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(buf);
      }
      if (req.method === "GET" && /^\/@[^/]+\/[^/]+$/.test(path) && path.slice(1) in latest) {
        const name = path.slice(1);
        const versions: Record<string, unknown> = {};
        for (const v of new Set([VER, latest[name]!])) {
          versions[v] = { name, version: v, dist: { tarball: `${base}/tgz/${encodeURIComponent(name)}` } };
        }
        return send(200, { name, "dist-tags": { latest: latest[name] }, versions });
      }
      return send(404, { error: "unhandled" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const certified = canonicalDigest(
    VER,
    Object.fromEntries(Object.entries(tarballs).map(([p, b]) => [p, createHash("sha256").update(b).digest("hex")])),
  );
  return { base, requests, latest, certified, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * Run the REAL emit step, then the REAL token step, under the real npm CLI. ONE
 * substitution: the `.npmrc` line's host `//registry.npmjs.org/` becomes the
 * stub's (and npm's registry points there); everything else is the YAML's text.
 * Asynchronous, so the in-process registry keeps answering while npm runs.
 */
async function runTokenStep(reg: Awaited<ReturnType<typeof localRegistry>>, token: string) {
  const trusted = trustedTree();
  const emitted = emitIn(trusted, reg.certified);
  expect(emitted.status, emitted.log).toBe(0);
  const block = /promote_block=(.+)/.exec(emitted.out)![1]!;
  const steps = job("promote").steps ?? [];
  const original = steps[steps.length - 1]?.run ?? "";
  const host = "//registry.npmjs.org/";
  expect(original.split(host).length - 1, "the .npmrc host appears exactly once").toBe(1);
  const script = original.replace(host, `${reg.base.replace(/^http:/, "")}/`);
  const dir = scratch();
  const runnerTemp = join(dir, "runner");
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(join(dir, "empty-globalconfig"), "");
  const file = join(dir, "token-step.sh");
  writeFileSync(file, script);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !/^npm_config_/i.test(k) && !/_proxy$/i.test(k) && k !== "NPM_TOKEN",
    ),
  ) as Record<string, string>;
  const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...inherited,
      HOME: join(dir, "home"),
      NPM_CONFIG_CACHE: join(dir, "npm-cache"),
      NPM_CONFIG_GLOBALCONFIG: join(dir, "empty-globalconfig"),
      NPM_CONFIG_REGISTRY: `${reg.base}/`,
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NPM_CONFIG_FETCH_RETRIES: "0",
      // The step's own env (release-promote.yml's token step).
      NPM_TOKEN: token,
      NPM_CONFIG_LOGLEVEL: "warn",
      VERSION: VER,
      BLOCK: block,
      TRUSTED: trusted,
      RUNNER_TEMP: runnerTemp,
    },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const npmrcPath = join(runnerTemp, "npmrc");
  let npmrc: string | null = null;
  try {
    npmrc = readFileSync(npmrcPath, "utf8");
  } catch {
    npmrc = null;
  }
  return { status, stdout, stderr, log: stdout + stderr, npmrc };
}
const puts = (reqs: RegistryRequest[]) => reqs.filter((r) => r.method === "PUT");

describe("release-promote — the token step with the real npm CLI against a local registry", () => {
  const TOKEN = "npm_FIXTURE0token0for0the0local0stub";

  test("the .npmrc indirection authenticates the dist-tag moves: client first, flair LAST", async () => {
    const reg = await localRegistry({ [CLIENT]: "1.2.2", [FLAIR]: "1.2.2" });
    try {
      const r = await runTokenStep(reg, TOKEN);
      expect(r.status, r.log).toBe(0);
      expect(r.stdout).toContain(`the convergence check observed latest at ${VER}`);
      // The file holds the LITERAL `${NPM_TOKEN}`; npm expanded it from the env.
      expect(r.npmrc).toBe(`${reg.base.replace(/^http:/, "")}/:_authToken=\${NPM_TOKEN}\n`);
      const moves = puts(reg.requests);
      expect(moves.map((m) => m.path)).toEqual([
        `/-/package/${CLIENT}/dist-tags/latest`,
        `/-/package/${FLAIR}/dist-tags/latest`,
      ]);
      for (const m of moves) {
        expect(m.auth).toBe(`Bearer ${TOKEN}`);
        expect(m.body).toBe(JSON.stringify(VER));
      }
      // Every npm-CLI request carried the token (the tarball download is the
      // hasher's plain fetch and needs none).
      for (const q of reg.requests.filter((q) => !q.path.startsWith("/tgz/"))) expect(q.auth).toBe(`Bearer ${TOKEN}`);
      expect(reg.latest).toEqual({ [CLIENT]: VER, [FLAIR]: VER });
      expect(r.log).not.toContain(TOKEN);
    } finally {
      await reg.close();
    }
  }, 120_000);

  test("a superseded version (a NEWER latest already published) is refused before the first move", async () => {
    const reg = await localRegistry({ [CLIENT]: "1.3.0", [FLAIR]: "1.2.2" });
    try {
      const r = await runTokenStep(reg, TOKEN);
      expect(r.status).not.toBe(0);
      expect(r.log).toContain(`the current latest of '${CLIENT}' is 1.3.0, NEWER than ${VER}; ${VER} is superseded`);
      expect(puts(reg.requests)).toEqual([]);
      expect(reg.latest).toEqual({ [CLIENT]: "1.3.0", [FLAIR]: "1.2.2" });
    } finally {
      await reg.close();
    }
  }, 120_000);

  test("a re-run after a partial move converges (equal latest is not superseded)", async () => {
    const reg = await localRegistry({ [CLIENT]: VER, [FLAIR]: "1.2.2" });
    try {
      const r = await runTokenStep(reg, TOKEN);
      expect(r.status, r.log).toBe(0);
      expect(reg.latest).toEqual({ [CLIENT]: VER, [FLAIR]: VER });
      // npm skips a tag already at the version; only flair is written.
      expect(puts(reg.requests).map((m) => m.path)).toEqual([`/-/package/${FLAIR}/dist-tags/latest`]);
    } finally {
      await reg.close();
    }
  }, 120_000);

  test("a failed dist-tag add stops at once with RESTORE lines, before the convergence check", async () => {
    const reg = await localRegistry({ [CLIENT]: "1.2.2", [FLAIR]: "1.2.2" }, { failPutFor: FLAIR });
    try {
      const r = await runTokenStep(reg, TOKEN);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`canary promote ABORTED at '${FLAIR}'`);
      expect(r.stderr).toContain(`npm dist-tag add ${CLIENT}@1.2.2 latest`);
      expect(r.stderr).toContain(`npm dist-tag add ${FLAIR}@1.2.2 latest`);
      // Nothing read the tags after the failed move: the skew check never ran.
      const failedAt = reg.requests.findIndex((q) => q.method === "PUT" && q.path === `/-/package/${FLAIR}/dist-tags/latest`);
      expect(failedAt).toBeGreaterThan(0);
      expect(reg.requests.slice(failedAt + 1)).toEqual([]);
      expect(r.log).not.toContain(TOKEN);
    } finally {
      await reg.close();
    }
  }, 120_000);

  test("an empty token is a named refusal that reaches no registry", async () => {
    const reg = await localRegistry({ [CLIENT]: "1.2.2", [FLAIR]: "1.2.2" });
    try {
      const r = await runTokenStep(reg, "");
      expect(r.status).toBe(1);
      expect(r.log).toContain("the release-promote environment (or its NPM_TOKEN secret) is not configured");
      expect(reg.requests).toEqual([]);
      expect(r.npmrc).toBeNull();
    } finally {
      await reg.close();
    }
  }, 120_000);
});

describe("release-promote — the promote job runs a known npm (exact pin, verified)", () => {
  const steps = () => job("promote").steps ?? [];
  const pinIndex = () => steps().findIndex((s) => s.id === "npm_pin");
  const pinned = () => String(steps()[pinIndex()]?.env?.NPM_PINNED ?? "");

  test("the pin-and-verify step exists, is exact, matches the canary's npm, and precedes the registry reads and tag moves", () => {
    expect(pinIndex(), "the npm_pin step exists").toBeGreaterThan(0);
    expect(pinned()).toMatch(/^\d+\.\d+\.\d+$/); // exact: no range, no tag
    const canaryPin = /npm install -g npm@(\d+\.\d+\.\d+)/.exec(canaryRaw)?.[1];
    expect(canaryPin, "the canary pins an exact npm").toBeDefined();
    expect(pinned(), "the promote's npm is the npm the canary ran").toBe(canaryPin!);
    const run = steps()[pinIndex()]?.run ?? "";
    expect(run).toContain('npm install -g "npm@${NPM_PINNED}"');
    expect(run).toContain('if [ "$GOT" != "$NPM_PINNED" ]; then');
    // setup-node (sha-pinned, no registry-url) comes right before it.
    const setup = steps()[pinIndex() - 1];
    expect(setup?.uses ?? "").toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(setup?.with?.["registry-url"]).toBeUndefined();
    // Before derive (the hasher's `npm view`), emit, and the token step.
    for (const id of ["derive", "emit"]) {
      expect(pinIndex(), `npm is pinned before ${id}`).toBeLessThan(steps().findIndex((s) => s.id === id));
    }
    const token = steps().findIndex((s) => JSON.stringify(s.env ?? {}).includes("NPM_TOKEN"));
    expect(pinIndex(), "npm is pinned before the token step").toBeLessThan(token);
    // …and after the guard, which stays the FIRST act.
    expect(pinIndex()).toBeGreaterThan(steps().findIndex((s) => s.id === "guard"));
  });

  /** Run the real pin step with a stub npm reporting `reports` from `npm --version`. */
  function runPin(reports: string) {
    const dir = scratch();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "npm.log");
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\nif [ "$1" = "--version" ]; then echo ${JSON.stringify(reports)}; fi\nexit 0\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    const r = runStep(steps()[pinIndex()]?.run ?? "", REPO, {
      PATH: `${bin}:${process.env.PATH}`,
      NPM_PINNED: pinned(),
    });
    return { ...r, calls: readFileSync(log, "utf8").trim().split("\n") };
  }

  test("the pinned version is installed from a job directory with an explicit userconfig, then verified", () => {
    const r = runPin(pinned());
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain(`npm ${pinned()} (pinned)`);
    const [cwd, args] = r.calls[0]!.split("|");
    expect(cwd).toEndWith("/npm-pin");
    expect(args).toMatch(new RegExp(`^install -g npm@${pinned().replace(/\./g, "\\.")} --userconfig .*/npm-pin/npmrc$`));
    expect(r.calls[1]).toEndWith("|--version");
  });

  test("any other npm version is a named refusal", () => {
    const r = runPin("10.9.4");
    expect(r.status).toBe(1);
    expect(r.log).toContain(`npm is '10.9.4', not the pinned ${pinned()}; refusing to promote with an unverified npm`);
    expect(r.log).not.toContain("(pinned)");
  });
});

// ── canary.yml: a FAILED tree selection runs no repository script ────────────
//
// GitHub's `if:` semantics for the expressions canary.yml uses: an expression
// with no status function gets an implicit `success()`; `success()` is false and
// `failure()` true once an earlier step failed; `always()` is true. The evaluator
// accepts ONLY those tokens (anything else throws), so a new condition shape must
// be taught here before the contract below can pass.
function stepRuns(cond: string | undefined, failedEarlier: boolean, selectOutcome: string): boolean {
  let expr = (cond ?? "").trim();
  if (expr.startsWith("${{") && expr.endsWith("}}")) expr = expr.slice(3, -2).trim();
  if (expr === "") expr = "success()";
  if (!/\b(?:success|failure|always|cancelled)\(\)/.test(expr)) expr = `success() && (${expr})`;
  const js = expr
    .replace(/\bsuccess\(\)/g, "S")
    .replace(/\bfailure\(\)/g, "F")
    .replace(/\balways\(\)/g, "true")
    .replace(/\bcancelled\(\)/g, "C")
    .replace(/\bsteps\.select\.outcome\b/g, "O")
    .replace(/==|!=/g, (m) => `${m}=`);
  if (!/^(?:\s|S|F|C|O|true|&&|\|\||!==|===|!|\(|\)|'[a-z]+')*$/.test(js)) {
    throw new Error(`unsupported if: expression: ${cond}`);
  }
  return new Function("S", "F", "C", "O", `return (${js});`)(!failedEarlier, failedEarlier, false, selectOutcome) as boolean;
}
/**
 * Walk canary.yml's steps for one scenario: `select` is the selection's outcome
 * and `failAt` the id of a later step that fails. Returns the steps that run.
 */
function canaryRunPlan(select: "success" | "failure", failAt?: string): Step[] {
  const all = canaryWf.jobs?.canary?.steps ?? [];
  const at = all.findIndex((s) => s.id === "select");
  expect(at, "the tree selection has id: select").toBe(1);
  let failed = select === "failure";
  const ran: Step[] = [];
  for (const st of all.slice(at + 1)) {
    if (!stepRuns(st.if, failed, select)) continue;
    ran.push(st);
    if (failAt && st.id === failAt) failed = true;
  }
  return ran;
}
const runsRepoScript = (st: Step) => /scripts\//.test(st.run ?? "");
const isVerdict = (st: Step) => (st.name ?? "").startsWith("Canary verdict — emit the promote or deprecate command");
const isInlineFail = (st: Step) => (st.name ?? "").startsWith("Canary verdict — FAIL, the tree selection did not succeed");

describe("canary.yml — a failed tree selection runs no repository script (contract)", () => {
  test("after a FAILED selection: no step runs a repository script; the inline FAIL verdict runs", () => {
    const ran = canaryRunPlan("failure");
    expect(ran.filter(runsRepoScript).map((s) => s.name)).toEqual([]);
    expect(ran.some(isInlineFail)).toBe(true);
    expect(ran.some(isVerdict)).toBe(false);
    // Positive control: the walk does see repository-script steps on success.
    expect(canaryRunPlan("success").filter(runsRepoScript).length).toBeGreaterThanOrEqual(6);
  });

  test("after a SUCCESSFUL selection, a later failed check still reaches the scripted FAIL verdict", () => {
    for (const failAt of ["sha", "install", "boot", "plugin"]) {
      const ran = canaryRunPlan("success", failAt);
      expect(ran.some(isVerdict), `verdict after a failed ${failAt}`).toBe(true);
      expect(ran.some(isInlineFail), `no inline FAIL after a failed ${failAt}`).toBe(false);
    }
    // A failed boot still runs the plugin step, to emit its own distinct line.
    expect(canaryRunPlan("success", "boot").some((s) => s.id === "plugin")).toBe(true);
    const clean = canaryRunPlan("success");
    expect(clean.some(isVerdict)).toBe(true);
    expect(clean.some(isInlineFail)).toBe(false);
  });

  test("the inline FAIL verdict names the failure and prints no deprecate line", () => {
    const st = (canaryWf.jobs?.canary?.steps ?? []).find(isInlineFail);
    expect(st, "the inline FAIL step exists").toBeDefined();
    expect(runsRepoScript(st!)).toBe(false);
    const dir = scratch();
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const r = runStep(st?.run ?? "", dir, {
      VERSION: "1.2.4",
      OS_NAME: "ubuntu-latest",
      SELECT_OUTCOME: "failure",
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(r.status).toBe(1);
    const verdict = readFileSync(join(dir, "canary-logs", "verdict.txt"), "utf8");
    expect(verdict).toContain("Canary FAIL — `ubuntu-latest` (tree selection: failure)");
    expect(verdict).toContain("Do not promote.");
    expect(verdict).not.toContain("npm deprecate");
    expect(readFileSync(summary, "utf8")).toBe(verdict);
  });
});

describe("canary.yml — a failed selection on a tampered tag executes none of the tag's code (real git)", () => {
  const CALLED = "octo/repo/.github/workflows/release-promote.yml@refs/tags/v1.2.4";
  test("selection refused in the tag workspace; every eligible run: step then leaves the tag's scripts unexecuted", () => {
    const fx = gitFixture();
    const MARK = "TAG-CODE-RAN";
    // The tag's verdict and plugin-check scripts leave a mark if they ever run.
    const tampered = commitPush(fx, {
      "scripts/ci/canary-verdict.sh": `#!/usr/bin/env bash\ntouch "$PWD/${MARK}"\necho tampered verdict\n`,
      [PLUGIN]: `import { writeFileSync } from "node:fs";\nwriteFileSync(process.cwd() + "/${MARK}", "plugin");\n`,
      [BOOT]: `#!/usr/bin/env bash\ntouch "$PWD/${MARK}"\n`,
    });
    tag(fx, "v1.2.4", tampered);
    const ws = workspaceAt(fx, tampered);
    const summary = join(scratch(), "summary.md");
    writeFileSync(summary, "");
    const prefix = join(scratch(), "prefix");
    const env: Record<string, string> = {
      TRUSTED_SHA: "",
      RUN_WORKFLOW_REF: CALLED,
      VERSION: "1.2.4",
      EXPECTED: "a".repeat(64),
      PKG_SET_DIGEST: "a".repeat(64),
      PACKAGE_SET_DIGEST: "a".repeat(64),
      OS_NAME: "ubuntu-latest",
      RUN_URL: "https://github.com/octo/repo/actions/runs/1",
      SELECT_OUTCOME: "failure",
      SHA_OUTCOME: "skipped",
      INSTALL_OUTCOME: "skipped",
      BOOT_OUTCOME: "skipped",
      PLUGIN_OUTCOME: "skipped",
      PREFIX: prefix,
      HOME: scratch(),
      GITHUB_STEP_SUMMARY: summary,
    };
    const select = (canaryWf.jobs?.canary?.steps ?? []).find((s) => s.id === "select");
    const sel = runStep(select?.run ?? "", ws, env);
    expect(sel.status).toBe(1);
    expect(sel.log).toContain("without a trusted_sha");
    expect(git(ws, "rev-parse", "HEAD")).toBe(tampered); // still the tag's tree
    // Run, in order, every `run:` step GitHub would run after that failure (the
    // `uses:` upload step is eligible too, but is an action, not executed here).
    const ran = canaryRunPlan("failure").filter((s) => s.run);
    expect(ran.length).toBeGreaterThan(0);
    for (const st of ran) runStep(st.run!, ws, env);
    expect(existsSync(join(ws, MARK)), "no tag script ran").toBe(false);
    expect(readFileSync(join(ws, "canary-logs", "verdict.txt"), "utf8")).toContain("Canary FAIL");
  });
});
