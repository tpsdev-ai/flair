#!/usr/bin/env node
/**
 * materialize-patched-harper.mjs — flair#847 pack/publish.
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
 * A nested `./vendor/harper-*.tgz` pin works for `npm i ./flair.tgz` and
 * fails for `npm i @tpsdev-ai/flair` from a registry (ENOENT on the nested
 * tarball). That is Cos's acceptance command, so it is not a publish pin.
 *
 * What reaches a registry consumer: replace Harper with a scoped reprint
 * (`@tpsdev-ai/harper`) that *itself* bundles a patched alasql (optional
 * peer, not optionalDep). Flair's published pin is
 * `"harper": "npm:@tpsdev-ai/harper@<ver>"` so oauth's `harper` peer still
 * hoists to `node_modules/harper`. Installed as a normal dependency,
 * Harper's shrinkwrap still expands, the platform RocksDB binding still
 * installs, and react-native does not.
 *
 * The git manifest stays `harper: <registry version>` so `npm pack` /
 * pack-smoke / this repo keep resolving upstream Harper. The alias rewrite
 * is publish-time only (`prepublishOnly --rewrite-alias`). `postpack`
 * restores only when `package.json.prepack-harper` exists — `npm pack`
 * does not run prepublishOnly, and pack-only Docker images do not COPY
 * this script. `--emit-dir` writes the reprint so release / the verdaccio
 * gate can publish it *before* Flair.
 *
 * Success logs go to stderr. `npm pack --silent` captures stdout as the
 * tarball path.
 *
 * Usage:
 *   node scripts/materialize-patched-harper.mjs --rewrite-alias
 *   node scripts/materialize-patched-harper.mjs --restore
 *   node scripts/materialize-patched-harper.mjs --emit-dir <dir>
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

export const PATCHED_HARPER_NAME = "@tpsdev-ai/harper";
export const PREPACK_BACKUP = "package.json.prepack-harper";

const REACT_NATIVE_FS = "react-native-fs";

export function npmAliasHarperSpec(version) {
  return `npm:${PATCHED_HARPER_NAME}@${version}`;
}

export function registryHarperSpec(dep) {
  if (typeof dep !== "string" || !dep) return null;
  if (/^[~^]?[\d.]+[-+\w.]*$/.test(dep)) return dep.replace(/^[~^]/, "");
  const fromAlias = dep.match(/^npm:@tpsdev-ai\/harper@(.+)$/);
  if (fromAlias) return fromAlias[1];
  const fromVendor = dep.match(/^\.\/vendor\/harper-(.+)\.tgz$/);
  return fromVendor ? fromVendor[1] : null;
}

export function rewriteHarperDepForPublish(pkg, version) {
  const next = { ...pkg, dependencies: { ...pkg.dependencies } };
  next.dependencies.harper = npmAliasHarperSpec(version);
  return next;
}

/** @deprecated use rewriteHarperDepForPublish — kept so a stale import fails loudly on the new pin. */
export function rewriteHarperDepForPack(pkg, version) {
  return rewriteHarperDepForPublish(pkg, version);
}

export function restoreHarperDep(pkg, version) {
  const next = { ...pkg, dependencies: { ...pkg.dependencies } };
  next.dependencies.harper = version;
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
  if (!moved && !pkg.peerDependencies?.[REACT_NATIVE_FS]) {
    throw new Error(`${pkgPath} has no react-native-fs optionalDependency to promote`);
  }
  return pkg;
}

export function stampPatchedHarperManifest(harperPkg) {
  const version = harperPkg.version;
  harperPkg.name = PATCHED_HARPER_NAME;
  harperPkg.description =
    `Flair reprint of harper@${version} with alasql's react-native-fs moved to an ` +
    `optional peer so npm i @tpsdev-ai/flair does not pull React Native (flair#847).`;
  harperPkg.publishConfig = { ...(harperPkg.publishConfig || {}), access: "public" };
  return harperPkg;
}

export function buildPatchedHarperPackage({ harperVersion, workDir, destDir, npmPack = packRegistryPackage }) {
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

  const bundle = new Set([
    ...(harperPkg.bundleDependencies || []),
    ...(harperPkg.bundledDependencies || []),
    "alasql",
  ]);
  harperPkg.bundleDependencies = [...bundle];
  delete harperPkg.bundledDependencies;
  stampPatchedHarperManifest(harperPkg);
  writeJson(join(harperDir, "package.json"), harperPkg);

  const shrinkwrapPath = join(harperDir, "npm-shrinkwrap.json");
  if (existsSync(shrinkwrapPath)) {
    const lock = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
    promoteReactNativeFsInLockfile(lock);
    const alasqlLock = lock.packages?.["node_modules/alasql"];
    if (alasqlLock) alasqlLock.inBundle = true;
    writeJson(shrinkwrapPath, lock);
  }

  writeFileSync(
    join(harperDir, "FLAIR-REPRINT.md"),
    [
      `# ${PATCHED_HARPER_NAME}`,
      "",
      `Reprint of \`harper@${harperPkg.version}\` for @tpsdev-ai/flair (flair#847).`,
      "AlaSQL's \`react-native-fs\` is an optional peer on the bundled copy.",
      "Do not install this package with \`--omit=optional\`: that also strips RocksDB.",
      "",
    ].join("\n"),
  );

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(harperDir, destDir, { recursive: true });
  if (!existsSync(join(destDir, "package.json"))) {
    throw new Error(`emit left no ${join(destDir, "package.json")}`);
  }
  return destDir;
}

export function emitPatchedHarper(callerRoot = process.cwd(), destDir) {
  if (!destDir) throw new Error("--emit-dir requires a destination directory");
  const pkg = JSON.parse(readFileSync(join(callerRoot, "package.json"), "utf8"));
  const version = registryHarperSpec(pkg.dependencies?.harper);
  if (!version) {
    throw new Error(
      `package.json dependencies.harper must be a registry version or npm:${PATCHED_HARPER_NAME}@<ver> (got ${pkg.dependencies?.harper})`,
    );
  }
  const workDir = mkdtempSync(join(tmpdir(), "flair-patched-harper-"));
  try {
    return buildPatchedHarperPackage({ harperVersion: version, workDir, destDir: resolve(destDir) });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function rewriteHarperAlias(callerRoot = process.cwd()) {
  const pkgPath = join(callerRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = registryHarperSpec(pkg.dependencies?.harper);
  if (!version) {
    throw new Error(
      `package.json dependencies.harper must be a registry version or npm:${PATCHED_HARPER_NAME}@<ver> (got ${pkg.dependencies?.harper})`,
    );
  }
  const backupPath = join(callerRoot, PREPACK_BACKUP);
  if (!existsSync(backupPath)) writeFileSync(backupPath, readFileSync(pkgPath));
  writeJson(pkgPath, rewriteHarperDepForPublish(pkg, version));
  return npmAliasHarperSpec(version);
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
  if (typeof pkg.dependencies?.harper === "string" && !pkg.dependencies.harper.startsWith("npm:")) {
    return null;
  }
  writeJson(pkgPath, restoreHarperDep(pkg, version));
  return version;
}

function parseCli(argv) {
  const out = { restore: false, rewriteAlias: false, emitDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--restore") out.restore = true;
    else if (argv[i] === "--rewrite-alias") out.rewriteAlias = true;
    else if (argv[i] === "--emit-dir") out.emitDir = argv[++i];
  }
  return out;
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && thisFile === invoked) {
  try {
    const args = parseCli(process.argv.slice(2));
    if (args.restore) {
      const version = restorePatchedHarper(process.cwd());
      if (version) console.error(`restored harper@${version} registry pin`);
    } else if (args.emitDir) {
      const dest = emitPatchedHarper(process.cwd(), args.emitDir);
      console.error(`emitted ${PATCHED_HARPER_NAME} → ${dest}`);
    } else if (args.rewriteAlias) {
      const spec = rewriteHarperAlias(process.cwd());
      console.error(`rewrote harper pin → ${spec}`);
    } else {
      console.error(
        "Usage: node scripts/materialize-patched-harper.mjs --rewrite-alias | --restore | --emit-dir <dir>",
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
