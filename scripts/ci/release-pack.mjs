#!/usr/bin/env node
/**
 * release-pack.mjs — slice A1a of flair#1671 ("pack once, stage from tarballs").
 *
 * WHY. Today the release workflow builds in one job and then stages each
 * package *from its source directory* (`cd packages/x && npm stage publish`).
 * Staging a directory means npm re-runs `prepack`/`prepublishOnly` at stage
 * time, so the bytes a maintainer later approves are built by a *different*
 * process from the bytes CI canaried. This script moves the build to a single
 * `pack` step: every publishable workspace package is packed ONCE into one
 * directory of tarballs, and a `manifest.json` binds each tarball's sha256 plus
 * a canonical package-set digest. The stage job then ships those exact tarballs.
 *
 * THE SET IS DERIVED, NOT LISTED. The publishable membership is
 * `lockstepPackages()` (scripts/ci/lockstep-packages.mjs) — the root package
 * plus every non-`private` workspace package. The `--dirs` argument carries the
 * workflow's dependency-ordered directory list, and this script REFUSES unless
 * that list names exactly the derived set: a missing, extra or duplicated
 * directory (a package packed twice) fails before any tarball is built.
 *
 * THE EXACT-PIN INVARIANT (flair#1671 Invariant 6). Every `@tpsdev-ai/*` entry
 * in `dependencies`, `peerDependencies` and `optionalDependencies` of every
 * published package must be an exact version equal to the release version. One
 * caret fails the pack before a single tarball is built: a range would let a
 * dependent install a sibling that has not been approved yet.
 *
 * TWO DIGESTS, NOT ONE. The package-set digest is the sha256 of the canonical,
 * sorted list of `name@version sha256` lines — one line per tarball. The
 * manifest digest is the sha256 of the manifest file's own bytes. `stage-publish`
 * recomputes both from what it downloaded and refuses on any mismatch, so the
 * bytes that reach npm are the bytes that were canaried.
 *
 * Usage:
 *   node scripts/ci/release-pack.mjs --out <dir> --version <X.Y.Z> [--root <dir>] \
 *        [--dirs <dir> ...]
 *
 * Exit codes:
 *   0 — one tarball per package, a manifest written, digests emitted
 *   1 — a pin, a tarball-set or a pack failure (never a partial success)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockstepPackages, ROOT } from "./lockstep-packages.mjs";

/** The dependency sections a published manifest ships. devDependencies do not ship. */
export const PIN_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"];
/** Our npm scope. Only our own names are lockstep siblings. */
export const OUR_SCOPE = "@tpsdev-ai/";

export class PackError extends Error {}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** npm's tarball basename for a package: `@scope/name` @ 1.2.3 -> `scope-name-1.2.3.tgz`. */
export function tarballBasename(name, version) {
  const stem = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${stem}-${version}.tgz`;
}

/** The canonical, sorted `name@version sha256` list the package-set digest hashes. */
export function packageSetLines(packages) {
  const lines = packages.map((p) => `${p.name}@${p.version} ${p.sha256}`);
  lines.sort();
  return lines.join("\n") + "\n";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Every publishable package manifest: the root package when it is not private,
 * plus each non-`private` `packages/<dir>/package.json`. Returns
 * `[{ name, dir, path, pkg }]`, `dir` relative to `root` ("." for the root).
 */
export function publishableManifests(root) {
  const out = [];
  const add = (dir, relPath) => {
    const pkgPath = join(root, relPath);
    if (!existsSync(pkgPath)) return;
    const pkg = readJson(pkgPath);
    if (typeof pkg?.name === "string" && pkg.name.length > 0 && pkg.private !== true) {
      out.push({ name: pkg.name, dir, path: relPath, pkg });
    }
  };
  add(".", "package.json");
  const packagesDir = join(root, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join("packages", entry.name), join("packages", entry.name, "package.json"));
    }
  }
  return out;
}

/**
 * The exact-pin invariant. Returns a list of human-readable violations; empty
 * means every dependency that names a LOCKSTEP MEMBER is pinned to exactly
 * `version`. Membership — not the `@tpsdev-ai/` scope — is the test: an
 * unscoped sibling (or one that later loses its scope) must not slip through.
 */
export function exactPinViolations(manifests, version, members) {
  const set = members instanceof Set ? members : new Set(members ?? []);
  const problems = [];
  for (const { name, path, pkg } of manifests) {
    for (const section of PIN_SECTIONS) {
      const deps = pkg[section];
      if (!deps || typeof deps !== "object") continue;
      for (const [dep, spec] of Object.entries(deps)) {
        if (!set.has(dep)) continue;
        if (spec !== version) {
          problems.push(`${path}: ${section}["${dep}"] is "${spec}", expected the exact release version "${version}"`);
        }
      }
    }
  }
  return problems;
}

/**
 * Resolve the ordered pack list. When `dirs` is supplied it is the workflow's
 * declared publish set and must name exactly the derived `lockstepPackages()`
 * set — no missing, extra or duplicated directory (a package packed twice).
 * Without `dirs`, the derived set is used.
 */
/**
 * Resolve the ordered pack list. When `dirs` is supplied it is the workflow's
 * declared publish set and must name exactly the derived `lockstepPackages()`
 * set: a missing, extra or duplicated directory (a package packed twice) is
 * refused HERE — before any `npm pack` runs — as well as by the post-pack set
 * check in `packAll`. Without `dirs`, the derived set is used.
 */
export function resolvePackOrder(root, dirs) {
  const manifests = publishableManifests(root);
  const byDir = new Map(manifests.map((m) => [m.dir, m.name]));
  const canonical = lockstepPackages(root);

  if (!dirs || dirs.length === 0) {
    const byName = new Map(manifests.map((m) => [m.name, m.dir]));
    return canonical.map((n) => byName.get(n));
  }

  const seen = new Set();
  const names = [];
  for (const raw of dirs) {
    const dir = raw.replace(/\/$/, "") || ".";
    if (seen.has(dir)) {
      throw new PackError(`the publish set lists "${dir}" twice; a package may be packed exactly once`);
    }
    seen.add(dir);
    const name = byDir.get(dir);
    if (!name) {
      throw new PackError(`the publish set names "${dir}", which is not a publishable package`);
    }
    names.push(name);
  }

  // Up-front coverage against the derived membership, so a missing member fails
  // BEFORE any tarball is built (the comment promised this; the check used to
  // live only after packing).
  const missing = canonical.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !canonical.includes(n));
  if (missing.length > 0) {
    throw new PackError(`the publish set is missing ${missing.join(", ")} from lockstepPackages(); refusing before any tarball is built`);
  }
  if (extra.length > 0) {
    throw new PackError(`the publish set adds ${extra.join(", ")}, which lockstepPackages() does not publish; refusing before any tarball is built`);
  }
  return dirs.map((d) => d.replace(/\/$/, "") || ".");
}

function packOne(root, dir, outAbs) {
  const cwd = join(root, dir);
  let stdout;
  try {
    stdout = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", outAbs],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch (err) {
    throw new PackError(`npm pack failed in ${dir}: ${err instanceof Error ? err.message : err}`);
  }
  let filename;
  try {
    const meta = JSON.parse(stdout);
    filename = Array.isArray(meta) ? meta[0]?.filename : undefined;
  } catch (err) {
    throw new PackError(`could not parse npm pack --json output in ${dir}: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof filename !== "string" || filename.length === 0) {
    throw new PackError(`npm pack in ${dir} produced no filename`);
  }
  return filename;
}

/** A tool's version string, or "unknown" when the tool cannot be run (best effort). */
function toolVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Pack every directory once, then assert the output directory is the expected set. */
export function packAll({ root, out, version, dirs }) {
  const order = resolvePackOrder(root, dirs);
  const byDir = new Map(publishableManifests(root).map((m) => [m.dir, m]));
  const outAbs = resolve(out);
  mkdirSync(outAbs, { recursive: true });

  // ── The exact-pin invariant, BEFORE any tarball is built. Membership is
  //    lockstepPackages(), so an unscoped sibling cannot slip through. ───────
  const members = lockstepPackages(root);
  const pinProblems = exactPinViolations(publishableManifests(root), version, members);
  if (pinProblems.length > 0) {
    throw new PackError(`exact-pin invariant violated:\n  ${pinProblems.join("\n  ")}`);
  }

  // ── One `npm pack` per package, into one output directory. ─────────────────
  const packed = [];
  for (const dir of order) {
    const manifest = byDir.get(dir);
    packOne(root, dir, outAbs);
    const basename = tarballBasename(manifest.name, manifest.pkg.version);
    packed.push({ name: manifest.name, version: manifest.pkg.version, basename });
  }

  // ── Exactly one tarball per member of lockstepPackages(); no missing, no
  //    extra, no duplicate. The expected set is the DERIVED membership, so a
  //    package the publish set skipped still fails here. ────────────────────
  const canonical = lockstepPackages(root);
  const expected = new Set(canonical.map((n) => tarballBasename(n, version)));
  const actual = readdirSync(outAbs).filter((f) => f.endsWith(".tgz"));
  const actualSet = new Set(actual);
  const missing = [...expected].filter((b) => !actualSet.has(b));
  const extra = actual.filter((b) => !expected.has(b));
  if (missing.length > 0 || extra.length > 0 || actual.length !== expected.size) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) parts.push(`unexpected: ${extra.join(", ")}`);
    if (actual.length !== expected.size && missing.length === 0 && extra.length === 0) {
      parts.push(`${actual.length} tarballs for ${expected.size} packages (duplicate)`);
    }
    throw new PackError(`the packed directory is not exactly one tarball per package — ${parts.join("; ")}`);
  }

  // ── The manifest: sorted list of name@version sha256, plus both digests. ───
  const packages = packed
    .map((p) => {
      const buf = readFileSync(join(outAbs, p.basename));
      return { name: p.name, version: p.version, basename: p.basename, size: statSync(join(outAbs, p.basename)).size, sha256: sha256Hex(buf) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const packageSetDigest = sha256Hex(packageSetLines(packages));
  const manifest = {
    schema: 1,
    version,
    repo: process.env.GITHUB_REPOSITORY ?? "",
    tag: process.env.GITHUB_REF_NAME ?? "",
    commit: process.env.GITHUB_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    tools: { node: toolVersion("node", ["--version"]), npm: toolVersion("npm", ["--version"]) },
    packages,
    packageSetDigest,
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  writeFileSync(join(outAbs, "manifest.json"), bytes);
  const manifestDigest = sha256Hex(bytes);

  return { manifest, manifestDigest, packageSetDigest, out: outAbs };
}

export function parseArgs(argv) {
  const out = { root: ROOT, out: null, version: null, dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") out.root = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--version") out.version = argv[++i];
    else if (arg === "--dirs") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.dirs.push(argv[++i]);
    } else throw new PackError(`unknown argument: ${arg}`);
  }
  if (!out.out) throw new PackError("--out <dir> is required");
  if (!out.version) {
    const rootPkg = readJson(join(out.root, "package.json"));
    out.version = rootPkg.version;
  }
  return out;
}

function emitOutputs(result) {
  const lines = [
    `package-set-digest=${result.packageSetDigest}`,
    `manifest-digest=${result.manifestDigest}`,
  ];
  const target = process.env.GITHUB_OUTPUT;
  if (target) {
    writeFileSync(target, lines.join("\n") + "\n", { flag: "a" });
  }
  for (const line of lines) console.log(line);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`release-pack: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  try {
    const result = packAll({ root: args.root, out: args.out, version: args.version, dirs: args.dirs });
    console.log(`packed ${result.manifest.packages.length} package(s) into ${args.out}`);
    for (const p of result.manifest.packages) console.log(`  ${p.name}@${p.version}  ${p.sha256}  ${p.basename}`);
    emitOutputs(result);
  } catch (err) {
    console.error(`release-pack: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
