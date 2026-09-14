#!/usr/bin/env node
/**
 * first-publish-check.mjs — hard-stop an unapproved first-publish of a public
 * package name under our npm org (flair#1674).
 *
 * WHY. First-publishing @tpsdev-ai/harper — a republished third-party database
 * — rode into the v0.54.0 release inside a technical fix (#847) and was only
 * caught at the 2FA approval gate. A new public name under our org is
 * near-irreversible and is a real ownership / brand / maintenance commitment,
 * so it has to be a deliberate, recorded act. Encoding it as an implementation
 * detail means it gets reviewed as code and never surfaces to a decision-maker.
 *
 * SHAPE. The default is "a new public package name = BLOCKED." Publishing one
 * requires a positive approval entry in `.release/first-publish-approved.json`
 * (name + approver + date + reason) — never the mere absence of an objection.
 *
 * WHAT IT ENUMERATES. Every package the release *would* publish:
 *   1. workspace packages whose package.json is not `private: true`, plus the
 *      root package if it is publishable; and
 *   2. any `npm:<name>@<version>` alias referenced by a published package's
 *      dependencies, optionalDependencies, or peerDependencies whose target is
 *      in OUR scope (`@tpsdev-ai/`). Peer aliases ship in the published
 *      manifest and npm auto-installs them, so they are a first-publish path
 *      too. devDependencies are excluded: they are not shipped. That is the
 *      Harper shape: a reprint the release pipeline materialises and
 *      publishes, referenced by an already-published dependency rather than
 *      declared as its own workspace package. It also cross-checks the
 *      enumeration against the tag workflow's actual publish set
 *      (release-publish.yml's `DIRS` array + stage-publish steps) and BLOCKS
 *      on any drift, so the two lists cannot diverge.
 *
 * For each target it asks the registry whether the name is already live
 * (`npm view <name> version`; 404 = first-publish) and cross-checks any
 * first-publish against the allow-list.
 *
 * FAIL SAFE. A registry or network error is NOT "assume it exists." It is
 * "cannot confirm live" and BLOCKS, because the whole point is to stop a
 * near-irreversible first-publish; a check that fails open on a flaky network
 * would be theater.
 *
 * WIRING. Called early by `scripts/release.sh` (both the release-PR path and
 * the break-glass publish path) and by CI on `release/v*` pull requests.
 *
 * THE ALLOW-LIST STARTS EMPTY, DELIBERATELY. Do not pre-seed it. flair-bench
 * and flair-tool-descriptors were (at the time this gate was written) public
 * workspace packages that were not yet live on the registry, so the next
 * release cut flags them — that is the feature working. It forces the pending
 * decision (publish this name under our org, or pull it from the release) to
 * be made explicitly and recorded, by a human, instead of accreting through a
 * technical change.
 *
 * Usage:
 *   node scripts/first-publish-check.mjs
 *   node scripts/first-publish-check.mjs --root <dir> [--allow-list <path>]
 *   FPC_ALLOW_FIXTURE=1 node scripts/first-publish-check.mjs --lookup-fixture <path>  # tests only
 *
 * Exit codes:
 *   0 — every publish target is already live, or is an approved first-publish
 *   1 — an unapproved first-publish, an unconfirmable lookup, or an
 *       unreadable/invalid allow-list (the release is blocked)
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(SCRIPT_DIR, "..");

/** Our npm scope. Only aliases into our own scope are reprints we'd publish. */
export const OUR_SCOPE = "@tpsdev-ai/";
/** Repo-relative path of the approvals file. The message names this literally. */
export const ALLOW_LIST_REL = ".release/first-publish-approved.json";
/**
 * The tag-triggered release workflow. Its `DIRS` array + stage-publish steps are
 * the actual publish set, so its path is where the drift assertion reads from.
 */
export const RELEASE_PUBLISH_WORKFLOW_REL = ".github/workflows/release-publish.yml";
/**
 * The one registry the check and `npm publish` agree on. Deliberately NOT
 * overridable by env: a release host with FLAIR_NPM_REGISTRY pointed at a mirror
 * that serves every name as live would fail this check open while `npm publish`
 * still targeted npmjs.org.
 */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** Every approval entry must carry all of these to count as a positive act. */
const REQUIRED_APPROVAL_FIELDS = ["name", "approver", "date", "reason"];

function firstLine(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  return (
    lines.find((l) =>
      /(?:^|\W)error|E[A-Z]{2,}|timed out|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|network/i.test(l),
    ) ?? lines[0]
  );
}

/**
 * Parse the target name out of an `npm:` alias specifier.
 *   "npm:@tpsdev-ai/harper@5.2.8" -> "@tpsdev-ai/harper"
 *   "npm:left-pad@1.0.0"          -> "left-pad"
 *   "npm:@scope/pkg"              -> "@scope/pkg"
 *   "^1.2.3" / "*"                -> null (not an alias)
 */
export function parseNpmAliasTarget(spec) {
  if (typeof spec !== "string" || !spec.startsWith("npm:")) return null;
  const rest = spec.slice(4);
  if (rest === "") return null;
  // Scoped names have their own leading "@", so the version separator is the
  // first "@" *after* the scope's "/".
  let versionAt;
  if (rest.startsWith("@")) {
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    versionAt = rest.indexOf("@", slash);
  } else {
    versionAt = rest.indexOf("@");
  }
  const name = versionAt === -1 ? rest : rest.slice(0, versionAt);
  return name === "" ? null : name;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Workspace patterns, handling both `workspaces: [...]` and `{ packages: [...] }`. */
function workspacePatterns(rootPkg) {
  const ws = rootPkg.workspaces;
  if (Array.isArray(ws)) return ws;
  if (typeof ws === "string") return [ws];
  if (ws && Array.isArray(ws.packages)) return ws.packages;
  return [];
}

/**
 * Expand a workspace pattern to repo-relative directories. Only the common
 * "<dir>/*" shape is supported; anything else is reported as a problem rather
 * than silently skipped, because a silently-skipped workspace directory is
 * exactly the package this gate would then fail to protect.
 */
function expandWorkspacePattern(root, pattern, problems) {
  if (typeof pattern !== "string" || pattern === "") return [];
  if (pattern.startsWith("!")) {
    problems.push(
      `unsupported workspaces pattern "${pattern}" (negation). Update scripts/first-publish-check.mjs so no package is silently skipped.`,
    );
    return [];
  }
  if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
    const base = pattern.slice(0, -2);
    let entries;
    try {
      entries = readdirSync(join(root, base), { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return []; // declared but absent — nothing to publish
      problems.push(`workspaces pattern "${pattern}" could not be read: ${err.message}`);
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => join(base, e.name));
  }
  if (pattern.includes("*") || pattern.includes("?")) {
    problems.push(
      `unsupported workspaces pattern "${pattern}" — this check only expands "<dir>/*" globs. Update scripts/first-publish-check.mjs rather than risk missing a package.`,
    );
    return [];
  }
  return [pattern];
}

/**
 * Extract every directory the tag-triggered release workflow publishes from:
 *   - the `DIRS=( ... )` array used by the dependency-order stage-publish loop, and
 *   - each standalone step's `cd <dir> && npm stage publish` command.
 * Variable references (the loop's `cd "$dir"`) are skipped — the DIRS array
 * already carries those paths. Returns repo-relative dirs, de-duped in order.
 */
export function parseReleasePublishDirs(workflowText) {
  const text = String(workflowText ?? "");
  const dirs = [];

  const dirsBlock = /DIRS=\(\s*([\s\S]*?)\s*\)/.exec(text);
  if (dirsBlock) {
    for (const line of dirsBlock[1].split("\n")) {
      const dir = line.replace(/#.*$/, "").trim();
      if (dir === "") continue;
      dirs.push(dir);
    }
  }

  const stageCmd = /cd\s+([^\s&)]+)\s*&&\s*npm\s+stage\s+publish/g;
  let match;
  while ((match = stageCmd.exec(text)) !== null) {
    const raw = match[1];
    if (raw.includes("$")) continue; // runtime variable — resolved from DIRS above
    dirs.push(raw.replace(/^["']|[\"']$/g, ""));
  }

  return [...new Set(dirs)];
}

/**
 * Cross-check the workspace enumeration against release-publish.yml's publish
 * set — the paths the tag workflow actually stages. Two directions, both
 * problems (a problem blocks):
 *   - a directory the workflow publishes that the enumeration did not cover
 *     (e.g. a `vendor/rogue` DIRS entry, or a reprint emitted outside the
 *     workspace), and
 *   - an enumerated workspace/root package absent from the workflow's publish
 *     dirs.
 * `npm:` alias targets are excluded from the second direction: reprints are
 * materialised outside the workspace (a mktemp --emit-dir) and are not DIRS
 * entries by construction — the registry lookup covers them. If the workflow
 * file is absent the drift check is skipped; absent, there is no tag publish
 * path to drift against.
 */
function checkPublishSetDrift(root, publishable, problems) {
  let workflowText;
  try {
    workflowText = readFileSync(join(root, RELEASE_PUBLISH_WORKFLOW_REL), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return;
    problems.push(`could not read ${RELEASE_PUBLISH_WORKFLOW_REL}: ${err.message}`);
    return;
  }

  const dirs = parseReleasePublishDirs(workflowText);
  if (dirs.length === 0) {
    problems.push(
      `${RELEASE_PUBLISH_WORKFLOW_REL} declares no publish directories (no DIRS array, no "npm stage publish" steps). Refusing to treat the publish set as empty.`,
    );
    return;
  }

  const dirToPkgPath = (dir) => {
    const clean = dir.replace(/\/$/, "");
    return clean === "." ? "package.json" : `${clean}/package.json`;
  };
  const dirSet = new Set(dirs.map(dirToPkgPath));
  const publishablePaths = new Set(publishable.map((p) => p.path));

  for (const dir of dirs) {
    const pkgPath = dirToPkgPath(dir);
    if (publishablePaths.has(pkgPath)) continue;
    problems.push(
      `${RELEASE_PUBLISH_WORKFLOW_REL} publishes "${dir}" (${pkgPath}) but the package enumeration did not cover it. Update scripts/first-publish-check.mjs so the publish set has one source of truth.`,
    );
  }

  for (const { path } of publishable) {
    if (dirSet.has(path)) continue;
    problems.push(
      `enumerated publishable package ${path} is absent from ${RELEASE_PUBLISH_WORKFLOW_REL}'s publish set (DIRS + stage-publish steps). The two publish sets have drifted.`,
    );
  }
}

/**
 * Enumerate every package the release would publish.
 * Returns { targets: [{ name, source }], problems: string[] }.
 */
export function enumeratePublishTargets(root = DEFAULT_ROOT) {
  const problems = [];
  const targets = new Map(); // name -> source

  const add = (name, source) => {
    if (typeof name !== "string" || name === "") return;
    if (!targets.has(name)) targets.set(name, source);
  };

  let rootPkg;
  const rootPkgPath = join(root, "package.json");
  try {
    rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  } catch (err) {
    problems.push(`could not read ${rootPkgPath}: ${err.message}`);
    return { targets: [], problems };
  }

  // Publishable directories: the root plus every public workspace package.
  const publishable = [];
  if (rootPkg.private !== true) {
    add(rootPkg.name, "package.json");
    publishable.push({ pkg: rootPkg, path: "package.json" });
  }

  const workspaceDirs = [];
  for (const pattern of workspacePatterns(rootPkg)) {
    workspaceDirs.push(...expandWorkspacePattern(root, pattern, problems));
  }
  for (const dir of workspaceDirs) {
    const pkgPath = join(root, dir, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") continue; // e.g. a Python package dir — not a workspace npm package
      problems.push(`could not read ${dir}/package.json: ${err.message}`);
      continue;
    }
    if (pkg.private === true) continue;
    add(pkg.name, `${dir}/package.json`);
    publishable.push({ pkg, path: `${dir}/package.json` });
  }

  // npm: aliases into our scope, referenced by a package we would publish.
  for (const { pkg, path } of publishable) {
    for (const depKind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = pkg[depKind];
      if (!deps || typeof deps !== "object") continue;
      for (const [depName, spec] of Object.entries(deps)) {
        const target = parseNpmAliasTarget(spec);
        if (!target || !target.startsWith(OUR_SCOPE)) continue;
        add(target, `npm: alias in ${path} ("${depName}")`);
      }
    }
  }

  checkPublishSetDrift(root, publishable, problems);

  return {
    targets: [...targets.entries()]
      .map(([name, source]) => ({ name, source }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  };
}

/**
 * Parse the approvals file. Accepts `{"approved": [...]}` (or a bare array, for
 * tolerance) and requires every entry to carry name/approver/date/reason — an
 * incomplete entry is not a positive act, so it is reported and does not
 * approve. Returns { approvedNames, entries, problems }.
 */
export function parseApprovals(raw, source = ALLOW_LIST_REL) {
  const problems = [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      approvedNames: new Set(),
      entries: [],
      problems: [`${source} is not valid JSON: ${err.message}`],
    };
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.approved) ? data.approved : null;
  if (list === null) {
    return {
      approvedNames: new Set(),
      entries: [],
      problems: [`${source} must be an object with an "approved" array, or a bare array.`],
    };
  }

  const approvedNames = new Set();
  const entries = [];
  for (const [i, entry] of list.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${source} entry ${i} is not an object.`);
      continue;
    }
    const record = entry;
    const missing = REQUIRED_APPROVAL_FIELDS.filter(
      (field) => typeof record[field] !== "string" || record[field].trim() === "",
    );
    if (missing.length > 0) {
      problems.push(
        `${source} entry ${i} (${typeof record.name === "string" ? record.name : "unnamed"}) is missing: ${missing.join(", ")}. An incomplete entry is not an approval.`,
      );
      continue;
    }
    approvedNames.add(record.name);
    entries.push({
      name: record.name,
      approver: record.approver,
      date: record.date,
      reason: record.reason,
    });
  }
  return { approvedNames, entries, problems };
}

/**
 * Real registry lookup: `npm view <name> version`.
 *   exit 0    -> live
 *   E404      -> missing (first-publish)
 *   any other -> error ("cannot confirm live" — blocks)
 */
export async function lookupViaNpm(name, { timeoutMs = 60_000 } = {}) {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", name, "version", "--json", `--registry=${DEFAULT_REGISTRY}`],
      {
        timeout: timeoutMs,
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    );
    const version = String(stdout).trim().replace(/^"|"$/g, "");
    return { state: "live", version: version || "?" };
  } catch (err) {
    const text = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join("\n");
    if (/E404|404 Not Found|is not in this registry/i.test(text)) {
      return { state: "missing" };
    }
    return { state: "error", error: firstLine(text) || "npm view failed" };
  }
}

/**
 * Evaluate the publish surface. `lookup` is injectable so unit tests never hit
 * the registry; production passes `lookupViaNpm`.
 */
export async function runCheck({
  root = DEFAULT_ROOT,
  lookup = lookupViaNpm,
  allowListPath = join(root, ALLOW_LIST_REL),
  readFile = (path) => readFileSync(path, "utf8"),
} = {}) {
  const problems = [];
  let approvedNames = new Set();
  let approvalEntries = [];

  let raw = null;
  try {
    raw = readFile(allowListPath);
  } catch (err) {
    // A missing allow-list simply means "no approvals" — still fail-closed,
    // because every first-publish then blocks. Any other read failure cannot
    // be verified, so it is a problem.
    if (err?.code !== "ENOENT") {
      problems.push(`${ALLOW_LIST_REL} could not be read: ${err.message}`);
    }
  }
  if (raw !== null && raw !== undefined) {
    const parsed = parseApprovals(raw, ALLOW_LIST_REL);
    approvedNames = parsed.approvedNames;
    approvalEntries = parsed.entries;
    problems.push(...parsed.problems);
  }

  const enumerated = enumeratePublishTargets(root);
  problems.push(...enumerated.problems);

  const live = [];
  const firstPublishes = [];
  const cannotConfirm = [];
  for (const target of enumerated.targets) {
    let result;
    try {
      result = await lookup(target.name);
    } catch (err) {
      result = { state: "error", error: firstLine(String(err?.message ?? err)) || "lookup threw" };
    }
    if (!result || typeof result !== "object" || typeof result.state !== "string") {
      result = { state: "error", error: "lookup returned no usable result" };
    }
    if (result.state === "live") {
      live.push({ ...target, version: typeof result.version === "string" ? result.version : "?" });
    } else if (result.state === "missing") {
      firstPublishes.push(target.name);
    } else {
      cannotConfirm.push({
        name: target.name,
        error: typeof result.error === "string" ? result.error : "unknown lookup error",
      });
    }
  }

  const approved = firstPublishes.filter((n) => approvedNames.has(n));
  const unapproved = firstPublishes.filter((n) => !approvedNames.has(n));
  const blocked = unapproved.length > 0 || cannotConfirm.length > 0 || problems.length > 0;

  return {
    root,
    targets: enumerated.targets,
    live,
    firstPublishes,
    approved,
    unapproved,
    cannotConfirm,
    approvalEntries,
    problems,
    blocked,
  };
}

/** Human-readable block report (the required failure message lives here). */
export function formatReport(result) {
  const lines = [];
  if (result.problems.length > 0) {
    lines.push("FIRST-PUBLISH CHECK could not verify approvals:");
    for (const p of result.problems) lines.push(`  - ${p}`);
  }
  for (const c of result.cannotConfirm) {
    lines.push(
      `FIRST-PUBLISH CHECK CANNOT CONFIRM LIVE: ${c.name} (${c.error}). A registry or network failure is not evidence the package already exists. Fix the lookup and re-run; the release is blocked.`,
    );
  }
  for (const name of result.unapproved) {
    lines.push(
      `FIRST-PUBLISH DETECTED: ${name}. This puts a new public package under our org (near-irreversible). Add it to ${ALLOW_LIST_REL} with approver+reason, or remove it from the release.`,
    );
  }
  return lines.join("\n");
}

/** Human-readable success summary. */
export function formatSuccess(result) {
  const approved = result.approved.length > 0 ? `; approved first-publish(es): ${result.approved.join(", ")}` : "";
  return `✓ First-publish check: ${result.targets.length} publish target(s); all already live on npm${approved}.`;
}

function printUsage(stream = console.log) {
  stream(
    [
      "Usage: first-publish-check.mjs [--root <dir>] [--allow-list <path>] [--lookup-fixture <path>]",
      "",
      "  --root <dir>             repo root to enumerate (default: this repo)",
      `  --allow-list <path>      approvals file (default: <root>/${ALLOW_LIST_REL})`,
      "  --lookup-fixture <path>  test-only: JSON map of name -> lookup result, instead of npm",
      "                           (refused unless FPC_ALLOW_FIXTURE=1 is set)",
    ].join("\n"),
  );
}

function fixtureLookup(path) {
  const map = JSON.parse(readFileSync(path, "utf8"));
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new Error("fixture must be a JSON object mapping package name to a lookup result");
  }
  return async (name) => {
    const entry = map[name];
    if (!entry || typeof entry !== "object") {
      return { state: "error", error: `no fixture entry for ${name}` };
    }
    if (entry.state === "live") return { state: "live", version: entry.version ?? "?" };
    if (entry.state === "missing") return { state: "missing" };
    return { state: "error", error: entry.error ?? "fixture error" };
  };
}

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, allowList: null, lookupFixture: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a directory");
      opts.root = resolve(value);
    } else if (arg === "--allow-list") {
      const value = argv[++i];
      if (!value) throw new Error("--allow-list requires a path");
      opts.allowList = resolve(value);
    } else if (arg === "--lookup-fixture") {
      const value = argv[++i];
      if (!value) throw new Error("--lookup-fixture requires a path");
      opts.lookupFixture = resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }

  let lookup = lookupViaNpm;
  if (opts.lookupFixture) {
    if (process.env.FPC_ALLOW_FIXTURE !== "1") {
      throw new Error(
        "--lookup-fixture is a test-only registry seam and is refused unless FPC_ALLOW_FIXTURE=1 is set.",
      );
    }
    lookup = fixtureLookup(opts.lookupFixture);
  }

  const result = await runCheck({
    root: opts.root,
    lookup,
    allowListPath: opts.allowList ?? join(opts.root, ALLOW_LIST_REL),
  });

  if (result.blocked) {
    console.error("");
    console.error(formatReport(result));
    console.error("");
    console.error("BLOCKED. Nothing was released.");
    process.exitCode = 1;
    return;
  }

  console.log(formatSuccess(result));
  for (const entry of result.live) {
    console.log(`    live  ${entry.name}@${entry.version}`);
  }
  for (const name of result.approved) {
    console.log(`    approved  ${name}`);
  }
}

// Run only when invoked directly. Comparing argv[1] to this module's path works
// on every supported Node version (unlike `import.meta.main`) and lets unit
// tests import the functions without executing the check.
const invokedDirectly =
  typeof process.argv[1] === "string" && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`❌ First-publish check could not run: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}
