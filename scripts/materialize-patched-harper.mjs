#!/usr/bin/env node
/**
 * materialize-patched-harper.mjs — flair#847 pack/install.
 *
 * Repo-root `overrides` for react-native-fs apply only when this package is
 * the install root. A published `npm i @tpsdev-ai/flair` in a clean project
 * ignores them. Harper pins alasql@4.17.3; alasql still auto-installs
 * react-native-fs as an optionalDependency. npm 12 resolves that field even
 * when Harper's shrinkwrap omits a react-native-fs node.
 *
 * `bundleDependencies: ["harper"]` is the wrong tool: npm then treats the
 * bundled Harper as a complete tree and does not install RocksDB / fastify.
 * `--omit=optional` is also wrong: it strips `@harperfast/rocksdb-js-*`.
 *
 * What does work for a published consumer: depend on a packed Harper tarball
 * that *itself* bundles a patched alasql (optional peer, not optionalDep).
 * Installed as a normal dependency, Harper's shrinkwrap still expands, the
 * platform RocksDB binding still installs, and react-native does not.
 *
 * This script runs from `prepack`. It writes vendor/harper-<ver>.tgz and
 * rewrites package.json to `./vendor/harper-<ver>.tgz` (no `file:` prefix —
 * CI rejects `file:` in the git manifest). `postpack --restore` puts the
 * registry pin back so the working tree stays clean.
 *
 * Success logs go to stderr. `npm pack --silent` captures stdout as the
 * tarball path.
 *
 * Usage:
 *   node scripts/materialize-patched-harper.mjs           # prepack
 *   node scripts/materialize-patched-harper.mjs --restore # postpack
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  promoteReactNativeFsInLockfile,
  promoteReactNativeFsToOptionalPeer,
  stripPackLifecycleScripts,
} from "./alasql-rn-peer.mjs";

export const VENDOR_DIR = "vendor";
export const HARPER_TGZ_PREFIX = "harper-";
export const PREPACK_BACKUP = "package.json.prepack-harper";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function registryHarperSpec(dep) {
  if (typeof dep !== "string" || !dep) return null;
  if (/^[~^]?[\d.]+[-+\w.]*$/.test(dep)) return dep.replace(/^[~^]/, "");
  const fromVendor = dep.match(/^\.\/vendor\/harper-(.+)\.tgz$/);
  return fromVendor ? fromVendor[1] : null;
}

export function vendorHarperPath(version) {
  return `${VENDOR_DIR}/${HARPER_TGZ_PREFIX}${version}.tgz`;
}

export function rewriteHarperDepForPack(pkg, version) {
  const next = { ...pkg, dependencies: { ...pkg.dependencies } };
  next.dependencies.harper = `./${vendorHarperPath(version)}`;
  const files = Array.isArray(pkg.files) ? [...pkg.files] : [];
  if (!files.some((f) => String(f).replace(/\/+$/, "") === VENDOR_DIR)) {
    files.push(`${VENDOR_DIR}/`);
  }
  next.files = files;
  return next;
}

export function restoreHarperDep(pkg, version) {
  const next = { ...pkg, dependencies: { ...pkg.dependencies } };
  next.dependencies.harper = version;
  if (Array.isArray(pkg.files)) {
    next.files = pkg.files.filter((f) => String(f).replace(/\/+$/, "") !== VENDOR_DIR);
  }
  return next;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function runNpm(args, cwd) {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    throw new Error(`npm ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

function packRegistryPackage(name, version, destDir) {
  mkdirSync(destDir, { recursive: true });
  const out = runNpm(["pack", `${name}@${version}`, "--pack-destination", destDir, "--silent"], destDir);
  const filename = out.split("\n").filter(Boolean).pop();
  const tgz = join(destDir, filename);
  if (!existsSync(tgz)) throw new Error(`npm pack ${name}@${version} did not write ${tgz}`);
  return tgz;
}

function extractTarball(tgz, destDir) {
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tgz, "-C", destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar -xzf ${tgz} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  const pkgDir = join(destDir, "package");
  if (!existsSync(join(pkgDir, "package.json"))) {
    throw new Error(`tarball ${tgz} had no package/package.json`);
  }
  return pkgDir;
}

function patchAlasqlPackageDir(alasqlDir) {
  const pkgPath = join(alasqlDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const moved = promoteReactNativeFsToOptionalPeer(pkg);
  stripPackLifecycleScripts(pkg);
  writeJson(pkgPath, pkg);
  if (!moved && !pkg.peerDependencies?.[REACT_NATIVE_FS_SAFE]) {
    throw new Error(`${pkgPath} has no react-native-fs optionalDependency to promote`);
  }
  return pkg;
}

const REACT_NATIVE_FS_SAFE = "react-native-fs";

export function buildPatchedHarperTarball({ harperVersion, workDir, destTgz, npmPack = packRegistryPackage }) {
  const harperTgz = npmPack("harper", harperVersion, join(workDir, "harper-src"));
  const harperDir = extractTarball(harperTgz, join(workDir, "harper-extract"));
  const harperPkg = JSON.parse(readFileSync(join(harperDir, "package.json"), "utf8"));
  if (harperPkg.name !== "harper") {
    throw new Error(`expected harper package, got ${harperPkg.name}`);
  }
  const alasqlSpec = harperPkg.dependencies?.alasql;
  if (typeof alasqlSpec !== "string") {
    throw new Error("harper package.json does not declare dependencies.alasql");
  }
  const alasqlVersion = alasqlSpec.replace(/^[~^]/, "");
  const alasqlTgz = npmPack("alasql", alasqlVersion, join(workDir, "alasql-src"));
  const alasqlDir = extractTarball(alasqlTgz, join(workDir, "alasql-extract"));
  patchAlasqlPackageDir(alasqlDir);

  const bundledAlasql = join(harperDir, "node_modules", "alasql");
  rmSync(bundledAlasql, { recursive: true, force: true });
  mkdirSync(dirname(bundledAlasql), { recursive: true });
  cpSync(alasqlDir, bundledAlasql, { recursive: true });

  const bundle = new Set([...(harperPkg.bundleDependencies || []), ...(harperPkg.bundledDependencies || []), "alasql"]);
  harperPkg.bundleDependencies = [...bundle];
  delete harperPkg.bundledDependencies;
  writeJson(join(harperDir, "package.json"), harperPkg);

  const shrinkwrapPath = join(harperDir, "npm-shrinkwrap.json");
  if (existsSync(shrinkwrapPath)) {
    const lock = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
    promoteReactNativeFsInLockfile(lock);
    const alasqlLock = lock.packages?.["node_modules/alasql"];
    if (alasqlLock) alasqlLock.inBundle = true;
    writeJson(shrinkwrapPath, lock);
  }

  mkdirSync(dirname(destTgz), { recursive: true });
  const packedName = runNpm(["pack", "--ignore-scripts", "--silent"], harperDir);
  const packedTgz = join(harperDir, packedName.split("\n").filter(Boolean).pop());
  if (!existsSync(packedTgz)) throw new Error(`re-pack of patched harper did not write ${packedTgz}`);
  cpSync(packedTgz, destTgz);
  return destTgz;
}

export function materializePatchedHarper(callerRoot = process.cwd()) {
  const pkgPath = join(callerRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = registryHarperSpec(pkg.dependencies?.harper);
  if (!version) {
    throw new Error(
      `package.json dependencies.harper must be a registry version or ./vendor/harper-<ver>.tgz (got ${pkg.dependencies?.harper})`,
    );
  }
  const destTgz = join(callerRoot, vendorHarperPath(version));
  const workDir = mkdtempSync(join(tmpdir(), "flair-patched-harper-"));
  try {
    buildPatchedHarperTarball({ harperVersion: version, workDir, destTgz });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const backupPath = join(callerRoot, PREPACK_BACKUP);
  writeFileSync(backupPath, readFileSync(pkgPath));
  writeJson(pkgPath, rewriteHarperDepForPack(pkg, version));
  if (!existsSync(destTgz)) throw new Error(`materialize left no ${destTgz}`);
  return destTgz;
}

export function restorePatchedHarper(callerRoot = process.cwd()) {
  const pkgPath = join(callerRoot, "package.json");
  const backupPath = join(callerRoot, PREPACK_BACKUP);
  if (existsSync(backupPath)) {
    writeFileSync(pkgPath, readFileSync(backupPath));
    rmSync(backupPath, { force: true });
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return registryHarperSpec(pkg.dependencies?.harper);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = registryHarperSpec(pkg.dependencies?.harper);
  if (!version) return null;
  if (typeof pkg.dependencies?.harper === "string" && !pkg.dependencies.harper.startsWith("./")) {
    return null;
  }
  writeJson(pkgPath, restoreHarperDep(pkg, version));
  return version;
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && thisFile === invoked) {
  try {
    if (process.argv.includes("--restore")) {
      const version = restorePatchedHarper(process.cwd());
      if (version) console.error(`restored harper@${version} registry pin`);
    } else {
      const dest = materializePatchedHarper(process.cwd());
      console.error(`materialized patched harper → ${dest}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
