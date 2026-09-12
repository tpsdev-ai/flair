#!/usr/bin/env node
/**
 * check-published-rn-tree.mjs — flair#847.
 *
 * The react-native-fs override in this repo's package.json applies only at
 * the install root. `npm i -g` of the tarball and `bun install` in this repo
 * both look clean. The user's shape is `npm i @tpsdev-ai/flair` in an empty
 * project, where this package is a dependency and the override is ignored.
 *
 * A nested `./vendor/harper-*.tgz` pin also looks clean for `npm i ./flair.tgz`
 * and then ENOENT's when the same tarball is published and installed by
 * package name. Cos's acceptance is the registry command, so that is the
 * gate: publish patched Harper + Flair to a throwaway registry, then run
 * `npm i @tpsdev-ai/flair` in a clean directory that is not this repo.
 *
 * npm 10 reading Harper's shrinkwrap can omit react-native-fs (no locked
 * node). npm 12 still resolves alasql's optionalDependencies field and
 * pulls React Native. A check that uses the ambient npm, or that installs
 * globally (flair becomes the root), or that inspects this repo's tree,
 * cannot catch what users receive.
 *
 * This gate asserts:
 *   - node_modules/react-native is absent
 *   - node_modules/react-native-fs is absent
 *   - harper is present (npm: alias hoists @tpsdev-ai/harper)
 *   - the platform RocksDB binding is present (not the --omit=optional tree)
 *   - alasql still executes SQL (Node path never needed react-native-fs)
 *
 * Exit codes:
 *   0 — published-shape tree has no React Native; positive controls hold
 *   1 — React Native present, or a load-bearing package is missing
 *   2 — DID NOT RUN (npm 12 unavailable, registry/install failed)
 *
 * Usage:
 *   node scripts/check-published-rn-tree.mjs --from-workspace
 *   node scripts/check-published-rn-tree.mjs --tarball <packed.tgz>
 *   node scripts/check-published-rn-tree.mjs --tree <node_modules>
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { materializeBundledDescriptors } from "./materialize-bundled-descriptors.mjs";
import {
  PATCHED_HARPER_NAME,
  emitPatchedHarper,
  restorePatchedHarper,
  rewriteHarperAlias,
} from "./materialize-patched-harper.mjs";

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_DID_NOT_RUN = 2;

export const NPM12_SPEC = "npm@12.0.2";
export const FORBIDDEN_DIRS = ["react-native", "react-native-fs"];
export const FLAIR_PACKAGE = "@tpsdev-ai/flair";
export const VERDACCIO_SPEC = "verdaccio@5.31.1";

export function parseArgs(argv) {
  const out = { tree: null, tarball: null, npm: null, fromWorkspace: false, workspace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tree") out.tree = argv[++i];
    else if (a === "--tarball") out.tarball = argv[++i];
    else if (a === "--npm") out.npm = argv[++i];
    else if (a === "--from-workspace") out.fromWorkspace = true;
    else if (a === "--workspace") out.workspace = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function walkDirs(dir, visit, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    visit(e.name, p);
    if (e.name === "node_modules" || e.name.startsWith("@") || depth < 4) {
      walkDirs(p, visit, depth + 1);
    }
  }
}

export function findPackageDirs(nodeModulesDir, name) {
  const found = [];
  if (!nodeModulesDir || !existsSync(nodeModulesDir)) return found;
  walkDirs(nodeModulesDir, (dirName, dirPath) => {
    if (dirName === name && existsSync(join(dirPath, "package.json"))) found.push(dirPath);
  });
  return found;
}

export function listForbiddenPresent(nodeModulesDir) {
  const present = [];
  for (const name of FORBIDDEN_DIRS) {
    if (findPackageDirs(nodeModulesDir, name).length) present.push(name);
  }
  return present;
}

export function findRocksdbBindings(nodeModulesDir) {
  const found = [];
  walkDirs(nodeModulesDir, (dirName, dirPath) => {
    if (dirName.startsWith("rocksdb-js-") && existsSync(join(dirPath, "package.json"))) {
      found.push(dirPath);
    }
  });
  return found;
}

export function expectedRocksdbBindingName({
  platform = process.platform,
  arch = process.arch,
  libc = process.versions.libc,
} = {}) {
  if (platform === "darwin") return `rocksdb-js-darwin-${arch}`;
  if (platform === "win32") return `rocksdb-js-win32-${arch}`;
  if (platform === "linux") {
    const lib = libc === "musl" ? "musl" : "glibc";
    return `rocksdb-js-linux-${arch}-${lib}`;
  }
  return null;
}

export function evaluatePublishedTree(nodeModulesDir) {
  if (!nodeModulesDir || !existsSync(nodeModulesDir)) {
    return { didNotRun: true, reason: `installed tree not found: ${nodeModulesDir || "(empty path)"}` };
  }
  const forbidden = listForbiddenPresent(nodeModulesDir);
  const harper = findPackageDirs(nodeModulesDir, "harper");
  const rocksdbJs = findPackageDirs(nodeModulesDir, "rocksdb-js").filter((p) =>
    /[/\\]@harperfast[/\\]rocksdb-js$/.test(p),
  );
  const bindings = findRocksdbBindings(nodeModulesDir);
  const expectedBinding = expectedRocksdbBindingName();
  const bindingPresent =
    bindings.length > 0 &&
    (!expectedBinding || bindings.some((p) => p.endsWith(expectedBinding) || p.includes(`/${expectedBinding}`)));

  return {
    didNotRun: false,
    forbidden,
    harperPresent: harper.length > 0,
    rocksdbJsPresent: rocksdbJs.length > 0,
    bindingPresent,
    bindings,
    expectedBinding,
    harperDirs: harper,
  };
}

export function formatReport(result) {
  const lines = [];
  if (result.didNotRun) {
    lines.push("DID NOT RUN — published-tree React Native gate did not inspect a consumer install.");
    lines.push(result.reason);
    lines.push("Refusing to pass: a skipped check is how the override shipped as if it reached users (flair#847).");
    return lines.join("\n");
  }
  if (result.forbidden?.length) {
    lines.push("FAIL — React Native is present in a published-shape install (flair as a dependency, not this repo).");
    lines.push(`Forbidden packages: ${result.forbidden.join(", ")}`);
    lines.push("Repo-root overrides do not apply here. The alasql optionalDependency is still being installed.");
    return lines.join("\n");
  }
  const missing = [];
  if (!result.harperPresent) missing.push("harper");
  if (!result.rocksdbJsPresent) missing.push("@harperfast/rocksdb-js");
  if (!result.bindingPresent) {
    missing.push(result.expectedBinding ? `@harperfast/${result.expectedBinding}` : "a RocksDB platform binding");
  }
  if (missing.length) {
    lines.push("FAIL — React Native is absent, but a load-bearing package is missing.");
    lines.push(`Missing: ${missing.join(", ")}`);
    lines.push("A tree that shrank because optional platform bindings were omitted is the --omit=optional result, not a win.");
    return lines.join("\n");
  }
  lines.push("OK — published-shape install has no react-native / react-native-fs.");
  lines.push("Positive control: harper, @harperfast/rocksdb-js, and the platform RocksDB binding are present.");
  return lines.join("\n");
}

export function npmMajor(version) {
  const n = Number(String(version || "").split(".")[0]);
  return Number.isFinite(n) ? n : 0;
}

export function resolveNpm12(explicit, spawnFn = spawnSync) {
  if (explicit) {
    const v = spawnFn(explicit, ["--version"], { encoding: "utf8" });
    if (v.status !== 0) return { ok: false, reason: `npm binary ${explicit} failed: ${(v.stderr || v.stdout || "").trim()}` };
    const version = (v.stdout || "").trim();
    if (npmMajor(version) < 12) {
      return { ok: false, reason: `${explicit} is npm ${version}; this gate requires npm 12 (npm 10 false-passes against Harper's shrinkwrap)` };
    }
    return { ok: true, command: explicit, args: [], version };
  }
  const npx = spawnFn("npx", ["--yes", NPM12_SPEC, "--version"], { encoding: "utf8" });
  if (npx.status !== 0) {
    return {
      ok: false,
      reason: `npx ${NPM12_SPEC} --version failed — the gate must not run on ambient npm 10. ${(npx.stderr || npx.stdout || "").trim()}`,
    };
  }
  const version = (npx.stdout || "").trim();
  if (npmMajor(version) < 12) {
    return {
      ok: false,
      reason: `npx ${NPM12_SPEC} reported npm ${version}; this gate requires npm 12 (npm 10 false-passes against Harper's shrinkwrap)`,
    };
  }
  return { ok: true, command: "npx", args: ["--yes", NPM12_SPEC], version };
}

function libcInstallArgs() {
  if (process.platform === "linux" && !process.versions.libc) return ["--libc=glibc"];
  return [];
}

export function scopedRegistryNpmrc(registryUrl) {
  const url = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return `@tpsdev-ai:registry=${url}\n`;
}

export function writeVerdaccioConfig(dir, port) {
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.yaml");
  const yaml = [
    `storage: ${join(dir, "storage")}`,
    `listen: 127.0.0.1:${port}`,
    "max_body_size: 100mb",
    "web:",
    "  enable: false",
    "auth:",
    "  htpasswd:",
    `    file: ${join(dir, "htpasswd")}`,
    "    max_users: -1",
    "uplinks:",
    "  npmjs:",
    "    url: https://registry.npmjs.org/",
    "    cache: true",
    "packages:",
    "  '@tpsdev-ai/*':",
    "    access: $all",
    "    publish: $all",
    "    unpublish: $all",
    "  '**':",
    "    access: $all",
    "    publish: $all",
    "    proxy: npmjs",
    "logs: { type: stdout, format: pretty, level: warn }",
    "",
  ].join("\n");
  writeFileSync(configPath, yaml);
  return configPath;
}

export function pickFreePort() {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
    ],
    { encoding: "utf8" },
  );
  const port = Number((r.stdout || "").trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`could not pick a free port: ${(r.stderr || r.stdout || "").trim()}`);
  return port;
}

export function pingRegistry(url) {
  const r = spawnSync(
    process.execPath,
    ["-e", `fetch(${JSON.stringify(`${url.replace(/\/+$/, "")}/-/ping`)}).then((res)=>{if(!res.ok)process.exit(1);}).catch(()=>process.exit(1));`],
    { encoding: "utf8" },
  );
  return r.status === 0;
}

export function startVerdaccio(dir, port = pickFreePort()) {
  const configPath = writeVerdaccioConfig(dir, port);
  const logFile = join(dir, "verdaccio.log");
  const out = openSync(logFile, "w");
  const child = spawn("npx", ["--yes", VERDACCIO_SPEC, "--config", configPath], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (pingRegistry(url)) return { pid: child.pid, url, port, logFile, configPath };
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250)"]);
  }
  let log = "";
  try {
    log = readFileSync(logFile, "utf8");
  } catch {
    /* ignore */
  }
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  throw new Error(`verdaccio did not listen on ${url} within 60s.\n${log}`);
}

export function stopVerdaccio(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

function runNpm(args, cwd, extraEnv = {}) {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", env: { ...process.env, ...extraEnv } });
  if (result.status !== 0) {
    const raw = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    const detail = raw.length > 4000 ? raw.slice(-4000) : raw;
    throw new Error(`npm ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

export function registryAuthNpmrc(registryUrl) {
  const url = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  const host = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return [`registry=${url}`, `//${host}/:_authToken=flair-847-ci`, `//${host}/:always-auth=true`, ""].join("\n");
}

export function publishToRegistry(packageDirOrTgz, registryUrl, cwd = process.cwd()) {
  const userconfig = join(mkdtempSync(join(tmpdir(), "flair-847-npmrc-")), "npmrc");
  writeFileSync(userconfig, registryAuthNpmrc(registryUrl));
  const args = [
    "publish",
    packageDirOrTgz,
    "--registry",
    registryUrl,
    "--access",
    "public",
    "--ignore-scripts",
    "--loglevel",
    "error",
    "--userconfig",
    userconfig,
  ];
  try {
    return runNpm(args, cwd);
  } finally {
    rmSync(userconfig, { force: true });
  }
}

export function packFlairForRegistry(workspace, destDir = mkdtempSync(join(tmpdir(), "flair-847-pack-"))) {
  materializeBundledDescriptors(workspace);
  const spec = rewriteHarperAlias(workspace);
  let tgzName;
  try {
    tgzName = runNpm(["pack", "--ignore-scripts", "--silent", "--pack-destination", destDir], workspace);
  } finally {
    restorePatchedHarper(workspace);
  }
  const filename = tgzName.split("\n").filter(Boolean).pop();
  const tgz = join(destDir, filename);
  if (!existsSync(tgz)) throw new Error(`npm pack did not write ${tgz}`);
  return { tgz, harperSpec: spec };
}

export function installFlairFromRegistry(cleanDir, registryUrl, npmSpec) {
  writeFileSync(join(cleanDir, ".npmrc"), scopedRegistryNpmrc(registryUrl));
  const args = [
    ...npmSpec.args,
    "install",
    FLAIR_PACKAGE,
    "--no-audit",
    "--no-fund",
    ...libcInstallArgs(),
  ];
  const npm = spawnSync(npmSpec.command, args, { cwd: cleanDir, encoding: "utf8" });
  if (npm.status !== 0) {
    const detail = (npm.stderr || npm.stdout || "").trim() || `exit ${npm.status}`;
    return {
      didNotRun: true,
      reason: `npm 12 \`${npmSpec.command} ${[...npmSpec.args, "install", FLAIR_PACKAGE].join(" ")}\` in a clean dir failed. ${detail}`,
    };
  }
  return { didNotRun: false, tree: join(cleanDir, "node_modules") };
}

export function installFromPublishedRegistry(workspace, npmSpec, prefix = mkdtempSync(join(tmpdir(), "flair-847-registry-"))) {
  const verdaccioDir = join(prefix, "verdaccio");
  const harperDir = join(prefix, "harper");
  const cleanDir = join(prefix, "clean");
  mkdirSync(verdaccioDir, { recursive: true });
  mkdirSync(cleanDir, { recursive: true });

  let verdaccio;
  try {
    verdaccio = startVerdaccio(verdaccioDir);
    emitPatchedHarper(workspace, harperDir);
    publishToRegistry(harperDir, verdaccio.url, harperDir);
    const packed = packFlairForRegistry(workspace);
    publishToRegistry(packed.tgz, verdaccio.url, workspace);
    const installed = installFlairFromRegistry(cleanDir, verdaccio.url, npmSpec);
    return {
      ...installed,
      prefix,
      cleanDir,
      registryUrl: verdaccio.url,
      harperSpec: packed.harperSpec,
      verdaccioPid: verdaccio.pid,
    };
  } catch (err) {
    if (verdaccio?.pid) stopVerdaccio(verdaccio.pid);
    return {
      didNotRun: true,
      reason: err instanceof Error ? err.message : String(err),
      prefix,
      verdaccioPid: verdaccio?.pid,
    };
  }
}

export function installTarballAsDependency(tarball, npmSpec, prefix = mkdtempSync(join(tmpdir(), "flair-published-rn-"))) {
  if (!tarball || !existsSync(tarball)) {
    return { didNotRun: true, reason: `tarball not found: ${tarball || "(empty path)"}`, prefix };
  }
  writeFileSync(
    join(prefix, "package.json"),
    JSON.stringify({ name: "flair-published-rn-probe", version: "0.0.0", private: true }, null, 2) + "\n",
  );
  const args = [
    ...npmSpec.args,
    "install",
    "--no-audit",
    "--no-fund",
    ...libcInstallArgs(),
    tarball,
  ];
  const npm = spawnSync(npmSpec.command, args, { cwd: prefix, encoding: "utf8" });
  if (npm.status !== 0) {
    const detail = (npm.stderr || npm.stdout || "").trim() || `exit ${npm.status}`;
    return {
      didNotRun: true,
      reason: `npm 12 install of the tarball as a dependency failed — the gate did not inspect a consumer tree. ${detail}`,
      prefix,
    };
  }
  return { didNotRun: false, prefix, tree: join(prefix, "node_modules") };
}

export function runAlasqlControl(nodeModulesDir) {
  const dirs = findPackageDirs(nodeModulesDir, "alasql");
  if (!dirs.length) return { ok: false, reason: "alasql is not installed" };
  const script = `
    const alasql = require(${JSON.stringify(dirs[0])});
    const rows = alasql('CREATE TABLE t (name STRING); INSERT INTO t VALUES ("harper"); SELECT * FROM t');
    if (!Array.isArray(rows) || !rows.some((r) => Array.isArray(r) ? r.some((x) => x && x.name === "harper") : r && r.name === "harper")) {
      throw new Error("alasql control did not return harper: " + JSON.stringify(rows));
    }
  `;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || "").trim() || `alasql control exit ${r.status}` };
  }
  return { ok: true };
}

function finishMeasurement(measured, io, prefixToClean, verdaccioPid) {
  if (measured.alasqlFailed) {
    const report = [
      "FAIL — React Native is absent, but alasql no longer executes SQL.",
      measured.alasqlFailed,
    ].join("\n");
    io.err(report);
    if (verdaccioPid) stopVerdaccio(verdaccioPid);
    if (prefixToClean) rmSync(prefixToClean, { recursive: true, force: true });
    return EXIT_FAIL;
  }

  const report = formatReport(measured);
  const failed =
    measured.didNotRun ||
    (measured.forbidden && measured.forbidden.length > 0) ||
    !measured.harperPresent ||
    !measured.rocksdbJsPresent ||
    !measured.bindingPresent;
  if (failed) io.err(report);
  else io.log(report);

  if (verdaccioPid) stopVerdaccio(verdaccioPid);
  if (prefixToClean) rmSync(prefixToClean, { recursive: true, force: true });
  if (measured.didNotRun) return EXIT_DID_NOT_RUN;
  if (failed) return EXIT_FAIL;
  return EXIT_OK;
}

export function run(argv = process.argv.slice(2), io = { log: console.log, err: console.error }, spawnFn = spawnSync) {
  const args = parseArgs(argv);
  if (args.help || (!args.tree && !args.tarball && !args.fromWorkspace)) {
    io.err(
      "Usage: node scripts/check-published-rn-tree.mjs --from-workspace | --tarball <packed.tgz> | --tree <node_modules> [--npm <npm12>]",
    );
    return EXIT_DID_NOT_RUN;
  }

  let prefixToClean = null;
  let verdaccioPid = null;
  let measured;

  if (args.fromWorkspace) {
    const npmSpec = resolveNpm12(args.npm, spawnFn);
    if (!npmSpec.ok) {
      io.err(formatReport({ didNotRun: true, reason: npmSpec.reason }));
      return EXIT_DID_NOT_RUN;
    }
    const workspace = resolve(args.workspace || process.cwd());
    const installed = installFromPublishedRegistry(workspace, npmSpec);
    prefixToClean = installed.prefix;
    verdaccioPid = installed.verdaccioPid || null;
    if (installed.didNotRun) {
      io.err(formatReport({ didNotRun: true, reason: installed.reason }));
      if (verdaccioPid) stopVerdaccio(verdaccioPid);
      if (prefixToClean) rmSync(prefixToClean, { recursive: true, force: true });
      return EXIT_DID_NOT_RUN;
    }
    io.log(`clean-dir command: npm i ${FLAIR_PACKAGE}  (npm ${npmSpec.version}, registry ${installed.registryUrl})`);
    io.log(`published harper pin: ${installed.harperSpec}`);
    measured = evaluatePublishedTree(installed.tree);
    if (!measured.didNotRun && !measured.forbidden?.length && measured.harperPresent) {
      const sql = runAlasqlControl(installed.tree);
      if (!sql.ok) measured.alasqlFailed = sql.reason;
    }
    return finishMeasurement(measured, io, prefixToClean, verdaccioPid);
  }

  if (args.tarball) {
    const npmSpec = resolveNpm12(args.npm, spawnFn);
    if (!npmSpec.ok) {
      io.err(formatReport({ didNotRun: true, reason: npmSpec.reason }));
      return EXIT_DID_NOT_RUN;
    }
    const installed = installTarballAsDependency(args.tarball, npmSpec);
    prefixToClean = installed.prefix;
    if (installed.didNotRun) {
      io.err(formatReport({ didNotRun: true, reason: installed.reason }));
      if (prefixToClean) rmSync(prefixToClean, { recursive: true, force: true });
      return EXIT_DID_NOT_RUN;
    }
    measured = evaluatePublishedTree(installed.tree);
    if (!measured.didNotRun && !measured.forbidden?.length && measured.harperPresent) {
      const sql = runAlasqlControl(installed.tree);
      if (!sql.ok) measured.alasqlFailed = sql.reason;
    }
    return finishMeasurement(measured, io, prefixToClean, null);
  }

  measured = evaluatePublishedTree(args.tree);
  return finishMeasurement(measured, io, null, null);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
