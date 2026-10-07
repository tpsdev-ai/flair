#!/usr/bin/env node
// Shared-unit-lane shards (flair#2311).
//
// USAGE
//   node scripts/ci/lane-shards.mjs --list-all
//                                          every test-bearing lane step's name
//   node scripts/ci/lane-shards.mjs --shard <i> [--of <N>]
//                                          shard i's step names (1-based)
//   node scripts/ci/lane-shards.mjs --verify [--of <N>]
//                                          coverage gate: exit non-zero unless
//                                          the shards partition every
//                                          test-bearing step and every file
//   Every command refuses an argument it does not take, with exit status 2.

import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { testFiles } from "./test-files.mjs";
import { SHARDS, assignShards, listUnitFiles } from "./unit-shards.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `root unit tests`' own per-step limit (flair#2030): 450 s, 1.37x its slowest
 * measured run (327 s). It is set on each root unit shard step here because the
 * plan is built here; scripts/test-unit.ts re-exports it so the runner and its
 * tests keep one source of truth.
 */
export const ROOT_STEP_TIMEOUT_MS = 450_000;

/**
 * How many shards the shared unit lane is split across (flair#2311). Chosen from
 * the lane budget: the 780 s lane takes 533-741 s on green runs, so two shards
 * put the slowest shard near half the budget with the same headroom the root
 * step keeps after flair#2258. The workflow matrix and this constant are pinned
 * together by lane-shards.test.ts.
 */
export const LANE_SHARDS = 2;

/** The workspace packages whose unit tests the lane runs. */
export const WORKSPACE_PACKAGES = [
  "flair-tool-descriptors",
  "flair-mcp",
  "flair-client",
  "langgraph-flair",
  "n8n-nodes-flair",
  "openclaw-flair",
  "pi-flair",
  "flair-bench",
  "adk-flair-js",
  "cursor-wake-runner",
];

/**
 * @param {string} [root]
 */
export function unitPlan(root = ROOT) {
  const requiredFiles = (dir, recursive = true) => {
    const files = testFiles(join(root, dir), recursive);
    if (!files.length) throw new Error(`No unit test files found in ${dir}`);
    return files;
  };
  const rootUnitFiles = listUnitFiles(root);
  const isolatedFiles = requiredFiles("test/unit-isolated");
  const steps = [{
    // flair#1683: the private descriptor package is a build-time source, not a
    // dependency. Vendor its copy into both consumers before anything reads it.
    name: "vendor tool descriptors",
    cwd: root,
    args: ["scripts/vendor-tool-descriptors.mjs"],
    files: [],
  }];
  // Strict typechecks. bun's transpiler STRIPS types rather than checking them,
  // so no `bun test` step can see a type error: a tree that does not compile can
  // report a green lane. These mirror the "Type Check (strict)" CI job.
  const typecheckConfigs = [
    ["resources (strict)", "tsconfig.check.json"],
    ["src (strict, excl. cli.ts)", "tsconfig.check.src.json"],
    ["root CLI", "tsconfig.cli.json"],
    ["test suite (strict)", "tsconfig.test.check.json"],
  ];
  for (const [label, config] of typecheckConfigs) {
    steps.push({ name: `typecheck: ${label}`, cwd: root, args: ["x", "tsc", "--noEmit", "-p", config], files: [] });
  }
  steps.push({ name: "emit server for boundary guard", cwd: root, args: ["x", "tsc", "-p", "tsconfig.json", "--noCheck"], files: [] });
  steps.push({ name: "build root CLI", cwd: root, args: ["run", "build:cli"], files: [] });
  assignShards(rootUnitFiles, SHARDS).forEach((files, index) => {
    steps.push({
      name: `root unit tests (shard ${index + 1}/${SHARDS})`,
      cwd: root,
      args: files.length ? ["test", ...files.map(file => join(root, file))] : [],
      files: files.map(file => join(root, file)),
      timeoutMs: ROOT_STEP_TIMEOUT_MS,
      shard: { index: index + 1, of: SHARDS },
    });
  });
  for (const file of isolatedFiles) {
    steps.push({ name: relative(root, file), cwd: root, args: ["test", file], files: [file] });
  }
  steps.push({ name: "build flair-client", cwd: join(root, "packages/flair-client"), args: ["run", "build"], files: [] });
  steps.push({ name: "build flair-mcp", cwd: join(root, "packages/flair-mcp"), args: ["run", "build"], files: [] });
  // flair#1943: the langgraph-flair contract test asserts a TYPE-LEVEL
  // `const s: BaseStore = new FlairStore(...)` assignability that no `bun test`
  // step can see; type-check that one file against the peer package's types.
  steps.push({
    name: "typecheck: langgraph-flair contract (BaseStore assignability)",
    cwd: join(root, "packages/langgraph-flair"),
    args: [
      "x", "tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
      "--moduleResolution", "Bundler", "--types", "node,bun-types", "--esModuleInterop",
      "--skipLibCheck", "test/contract.test.ts",
    ],
    files: [],
  });
  for (const pkg of WORKSPACE_PACKAGES) {
    const dir = pkg === "adk-flair-js" ? "test/unit" : "test";
    const cwd = join(root, "packages", pkg);
    steps.push({ name: `${pkg} unit tests`, cwd, args: ["test", `./${dir}/`], files: requiredFiles(`packages/${pkg}/${dir}`) });
  }
  return [...sharedSteps(steps), ...shardedSteps(steps)];
}

/** A lane step is shardable work when it runs test files (root shards included). */
export function isShardedStep(step) {
  return step.shard !== undefined || step.files.length > 0 || step.args[0] === "test";
}

/** The file-bearing lane steps — the ones the shard partition is over. */
export function shardedSteps(steps) {
  return steps.filter(isShardedStep);
}

/** The steps every shard runs first: they carry no test files. */
export function sharedSteps(steps) {
  return steps.filter(step => !isShardedStep(step));
}

/** The load a test-bearing step contributes to its shard: its file count. */
export function weightOf(step) {
  return step.files.length || 1;
}

/**
 * Assign the test-bearing lane steps to `of` shards, deterministically. Steps
 * go in descending weight order into the currently-lightest shard (ties by
 * shard index), so the heavy root-unit shards are spread; a step with no weight
 * differences still lands in exactly one shard. Each shard is returned sorted
 * by step name.
 */
export function assignLaneShards(steps, of = LANE_SHARDS) {
  if (!Number.isInteger(of) || of < 1) {
    throw new Error(`lane shard count must be a positive integer, got ${of}`);
  }
  const ordered = shardedSteps(steps).sort(
    (a, b) => weightOf(b) - weightOf(a) || (a.name < b.name ? -1 : 1),
  );
  const buckets = Array.from({ length: of }, () => []);
  const loads = Array.from({ length: of }, () => 0);
  for (const step of ordered) {
    let lightest = 0;
    for (let i = 1; i < of; i++) if (loads[i] < loads[lightest]) lightest = i;
    buckets[lightest].push(step);
    loads[lightest] += weightOf(step);
  }
  return buckets.map(b => b.sort((a, b) => (a.name < b.name ? -1 : 1)));
}

/** Shard `index` (1-based) of `of`. Throws when the index is out of range. */
export function shardSteps(index, of = LANE_SHARDS, steps = unitPlan()) {
  if (!Number.isInteger(of) || of < 1) throw new Error(`--of must be a positive integer, got ${of}`);
  if (!Number.isInteger(index) || index < 1 || index > of) {
    throw new Error(`--shard must be 1..${of}, got ${index}`);
  }
  return assignLaneShards(steps, of)[index - 1];
}

/**
 * Every test file the lane runs, discovered from disk — independently of the
 * step plan, so a file dropped from the assignment (or from the plan) is
 * reported missing instead of silently shrinking the corpus. It must match the
 * union of `unitPlan()`'s step files on a clean tree; lane-shards.test.ts
 * pins that.
 */
export function listLaneFiles(root = ROOT) {
  const found = [
    ...testFiles(join(root, "test"), false),
    ...testFiles(join(root, "test", "unit"), true),
    ...testFiles(join(root, "test", "unit-isolated"), true),
  ];
  for (const pkg of WORKSPACE_PACKAGES) {
    const dir = pkg === "adk-flair-js" ? "test/unit" : "test";
    found.push(...testFiles(join(root, "packages", pkg, dir), true));
  }
  return found.sort();
}

export function laneShardPlans(steps, of = LANE_SHARDS) {
  return assignLaneShards(steps, of).map(shard => [...sharedSteps(steps), ...shard]);
}

function isPureTestStep(step) {
  if (step.shard !== undefined && !step.files.length && !step.args.length) return true;
  return step.args[0] === "test" && step.args.length > 1 && step.args.slice(1).every(arg => {
    const target = resolve(step.cwd, arg);
    return !arg.startsWith("-") && step.files.some(file => file === target || file.startsWith(target + sep));
  });
}

export function laneCoverage(steps, shards, allFiles = listLaneFiles()) {
  const corpusSteps = new Set(shardedSteps(steps).map(step => step.name));
  const setup = new Set(sharedSteps(steps).map(step => step.name));
  const corpusFiles = new Set(allFiles);
  const seenSteps = new Set();
  const seenFiles = new Set();
  const duplicatedSteps = [];
  const duplicatedFiles = [];
  const invalidTestSteps = new Set(shardedSteps(steps).filter(step => !isPureTestStep(step)).map(step => step.name));
  const invalidSharedSteps = [];
  for (const name of setup) {
    if (shards.some(shard => shard.filter(step => step.name === name).length !== 1)) invalidSharedSteps.push(name);
  }
  for (const shard of shards) {
    for (const step of shard) {
      if (setup.has(step.name)) {
        if (isShardedStep(step)) invalidSharedSteps.push(step.name);
        continue;
      }
      if (!isShardedStep(step) || !isPureTestStep(step)) invalidTestSteps.add(step.name);
      if (seenSteps.has(step.name)) duplicatedSteps.push(step.name);
      seenSteps.add(step.name);
      for (const file of step.files) {
        if (seenFiles.has(file)) duplicatedFiles.push(file);
        seenFiles.add(file);
      }
    }
  }
  return {
    totalSteps: corpusSteps.size,
    coveredSteps: seenSteps.size,
    totalFiles: corpusFiles.size,
    coveredFiles: seenFiles.size,
    missingSteps: [...corpusSteps].filter(name => !seenSteps.has(name)),
    duplicatedSteps,
    unknownSteps: [...seenSteps].filter(name => !corpusSteps.has(name)),
    missingFiles: [...corpusFiles].filter(file => !seenFiles.has(file)),
    duplicatedFiles,
    unknownFiles: [...seenFiles].filter(file => !corpusFiles.has(file)),
    invalidSharedSteps,
    invalidTestSteps: [...invalidTestSteps],
    empty: shards.flatMap((shard, index) => (shard.some(isShardedStep) ? [] : [index + 1])),
  };
}

export function verifyLaneShards(of = LANE_SHARDS, steps = unitPlan(), allFiles = listLaneFiles()) {
  return laneCoverage(steps, laneShardPlans(steps, of), allFiles);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usageError(msg) {
  process.stderr.write(
    `lane-shards: ${msg}\nUsage: node scripts/ci/lane-shards.mjs ` +
      `--list-all | --shard <i> [--of <N>] | --verify [--of <N>]\n`,
  );
  process.exit(2);
}

function parseOf(args) {
  const at = args.indexOf("--of");
  if (at === -1) return LANE_SHARDS;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 1) usageError(`--of must be a positive integer`);
  return value;
}

const isEntryPoint =
  process.argv[1] &&
  (() => {
    try {
      return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();
if (isEntryPoint) {
  const args = process.argv.slice(2);
  try {
    const seen = new Set();
    for (const arg of args.filter(arg => arg.startsWith("--"))) {
      if (seen.has(arg)) usageError(`repeated argument: ${arg}`);
      seen.add(arg);
      if (!["--list-all", "--verify", "--shard", "--of"].includes(arg)) {
        usageError(`unknown argument: ${arg}`);
      }
    }
    if (args.includes("--list-all")) {
      if (args.length !== 1) usageError(`--list-all takes no other arguments`);
      process.stdout.write(`${shardedSteps(unitPlan()).map(step => step.name).sort().join("\n")}\n`);
    } else if (args.includes("--verify")) {
      const rest = args.filter(a => a !== "--verify");
      const of = parseOf(rest);
      if (rest.length !== 0 && !(rest.length === 2 && rest[0] === "--of")) {
        usageError(`--verify takes only --of <N>`);
      }
      const res = verifyLaneShards(of);
      const bad = res.missingSteps.length || res.duplicatedSteps.length || res.unknownSteps.length ||
        res.missingFiles.length || res.duplicatedFiles.length || res.unknownFiles.length || res.empty.length || res.invalidSharedSteps.length || res.invalidTestSteps.length;
      process.stdout.write(
        `lane shards of ${of}: ${res.coveredSteps}/${res.totalSteps} steps and ` +
          `${res.coveredFiles}/${res.totalFiles} files covered, ` +
          `${res.missingSteps.length + res.missingFiles.length} missing, ` +
          `${res.duplicatedSteps.length + res.duplicatedFiles.length} duplicated\n`,
      );
      if (bad) {
        if (res.invalidSharedSteps.length) process.stderr.write(`setup not once in every shard: ${res.invalidSharedSteps.join(", ")}\n`);
        if (res.invalidTestSteps.length) process.stderr.write(`partitioned steps must only run tests: ${res.invalidTestSteps.join(", ")}\n`);
        if (res.empty.length) process.stderr.write(`empty shards: ${res.empty.join(", ")}\n`);
        if (res.missingSteps.length) process.stderr.write(`missing steps: ${res.missingSteps.join(", ")}\n`);
        if (res.missingFiles.length) process.stderr.write(`missing files: ${res.missingFiles.join(", ")}\n`);
        if (res.duplicatedSteps.length) process.stderr.write(`duplicated steps: ${res.duplicatedSteps.join(", ")}\n`);
        if (res.duplicatedFiles.length) process.stderr.write(`duplicated files: ${res.duplicatedFiles.join(", ")}\n`);
        if (res.unknownSteps.length) process.stderr.write(`unknown steps: ${res.unknownSteps.join(", ")}\n`);
        if (res.unknownFiles.length) process.stderr.write(`unknown files: ${res.unknownFiles.join(", ")}\n`);
        process.exit(1);
      }
    } else if (args.includes("--shard")) {
      const at = args.indexOf("--shard");
      const index = Number(args[at + 1]);
      const rest = args.filter((a, i) => a !== "--shard" && i !== at + 1);
      const of = parseOf(rest);
      if (rest.length !== 0 && !(rest.length === 2 && rest[0] === "--of")) {
        usageError(`--shard takes only --of <N>`);
      }
      process.stdout.write(`${shardSteps(index, of).map(step => step.name).sort().join("\n")}\n`);
    } else {
      usageError(`no command given`);
    }
  } catch (err) {
    process.stderr.write(`lane-shards: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
