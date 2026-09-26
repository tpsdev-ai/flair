#!/usr/bin/env node
/**
 * check-shipped-descriptors.mjs — flair#1683, second half: the SHIPPED artifact
 * must be the thing under test.
 *
 * What it closes. `test/unit/vendored-tool-descriptors.test.ts` pins vendored
 * SOURCE ≡ source of truth, and the root `prepack` re-vendors + rebuilds so a
 * bare `npm pack` cannot ship a stale `dist`. Neither of those reads the packed
 * tarball. This script does: it extracts the tarball(s) a release would publish,
 * imports the descriptor module that actually ships, and requires its descriptor
 * signature to equal the signature of `packages/flair-tool-descriptors/src/
 * index.ts`, evaluated fresh. A tarball with NO tool-descriptors entry fails
 * loudly (an empty/folded surface must not pass as "nothing to compare").
 *
 * Why a signature and not a byte comparison: the shipped file is `tsc` output and
 * a fresh in-test compile legitimately differs in formatting/comments. The
 * signature is count + every tool name + the native/stdio surface split +
 * a sha256 over the serialized descriptors (name, description AND inputSchema),
 * so a stale dist, a dropped tool, or an edited schema all fail while a
 * reformat does not. Tampering that survives the signature (e.g. an injected
 * comment) is removed by the root `prepack` rebuild — see the prepack tests.
 *
 * Usage:
 *   node scripts/check-shipped-descriptors.mjs --tarball <tgz> [--tarball <tgz>…]
 *   node scripts/check-shipped-descriptors.mjs --module ../dist/resources/tool-descriptors/index.js
 *   node scripts/check-shipped-descriptors.mjs --print-signature <module-url>   # internal
 *
 * Exit codes (mirrors the other check scripts):
 *   0 — every shipped descriptor module matches the source of truth
 *   1 — a shipped artifact is missing its descriptors, or they diverged
 *   2 — DID NOT RUN (no input, tarball/module missing, bun unavailable, extract
 *       failed) — never silently green.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/** The private build-time source that both consumers vendor (flair#1683). */
export const DESCRIPTORS_SRC_REL = join("packages", "flair-tool-descriptors", "src", "index.ts");
/** Every shipped copy is a module named exactly `tool-descriptors/index.js`. */
export const SHIPPED_REL_SUFFIX = join("tool-descriptors", "index.js");

export function repoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * The descriptor surface of an evaluated descriptor module: how many, which
 * names, the native/stdio split, and a digest over the full serialized
 * descriptors (so an edited inputSchema is a divergence, not a pass).
 */
export function descriptorSignature(mod) {
  const all = mod?.TOOL_DESCRIPTORS ?? [];
  const names = all.map((d) => d.name);
  const digest = createHash("sha256").update(JSON.stringify(all)).digest("hex");
  return {
    count: all.length,
    names: [...names].sort(),
    native: [...(mod?.NATIVE_TOOL_DESCRIPTORS ?? []).map((d) => d.name)].sort(),
    stdio: [...(mod?.STDIO_TOOL_DESCRIPTORS ?? []).map((d) => d.name)].sort(),
    digest,
  };
}

function signatureSummary(sig) {
  return `${sig.count} tools (native ${sig.native.length}, stdio ${sig.stdio.length}) sha256:${sig.digest.slice(0, 12)}`;
}

/** Name-level diff, for a failure that says WHAT diverged, not just that it did. */
export function diffSignatures(expected, actual) {
  const setDiff = (a, b) => a.filter((n) => !b.includes(n));
  return {
    missing: setDiff(expected.names, actual.names),
    extra: setDiff(actual.names, expected.names),
    countDelta: actual.count - expected.count,
    digestMatches: expected.digest === actual.digest,
  };
}

/**
 * Evaluate a module URL in a child runtime and return its signature. The source
 * of truth is TypeScript, so it needs bun; the shipped copies are plain ESM and
 * could be imported in-process, but both halves deliberately go through the same
 * `--print-signature` path so the two signatures can never be computed by
 * different code.
 */
export function signatureOfModule(moduleUrl, runtime) {
  const script = fileURLToPath(import.meta.url);
  const run = spawnSync(runtime, [script, "--print-signature", moduleUrl], { encoding: "utf8" });
  if (run.error) return { ok: false, error: `could not run ${runtime}: ${run.error.message}` };
  if (run.status !== 0) {
    return { ok: false, error: `${runtime} exit ${run.status}: ${(run.stderr || run.stdout || "").trim().split("\n").slice(-1)[0]}` };
  }
  try {
    return { ok: true, signature: JSON.parse(run.stdout) };
  } catch {
    return { ok: false, error: `unparseable signature from ${runtime}: ${run.stdout.trim().slice(0, 200)}` };
  }
}

/** Every `dist/<dir>/tool-descriptors/index.js` under an extracted tarball's `package/`. */
export function findShippedModules(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(SHIPPED_REL_SUFFIX) && relative(dir, path).split(sep).includes("dist")) found.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

function extractTarball(tarball, dest) {
  const run = spawnSync("tar", ["-xzf", tarball, "-C", dest], { encoding: "utf8" });
  if (run.error) return { ok: false, error: `tar failed: ${run.error.message}` };
  if (run.status !== 0) return { ok: false, error: `tar exit ${run.status}: ${(run.stderr || "").trim().split("\n").slice(-1)[0]}` };
  return { ok: true };
}

function parseArgs(argv) {
  const opts = { tarballs: [], modules: [], bun: "bun", printSignature: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tarball" || a === "--package") opts.tarballs.push(argv[++i]);
    else if (a === "--module") opts.modules.push(argv[++i]);
    else if (a === "--bun") opts.bun = argv[++i];
    else if (a === "--print-signature") opts.printSignature = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  // Internal mode: evaluate one module and print its signature (run under bun
  // for the TS source of truth).
  if (opts.printSignature) {
    const mod = await import(opts.printSignature);
    process.stdout.write(JSON.stringify(descriptorSignature(mod)));
    return;
  }

  if (opts.help) {
    console.error(
      "usage: node scripts/check-shipped-descriptors.mjs --tarball <tgz> [--tarball <tgz>…] | --module <path> [--bun <runtime>]",
    );
    process.exit(0);
  }
  if (!opts.tarballs.length && !opts.modules.length) {
    console.error("DID NOT RUN: pass at least one --tarball <tgz> or --module <path>");
    process.exit(2);
  }
  for (const tarball of opts.tarballs) {
    if (!existsSync(tarball)) {
      console.error(`DID NOT RUN: tarball not found: ${tarball}`);
      process.exit(2);
    }
  }
  for (const file of opts.modules) {
    if (!existsSync(file)) {
      console.error(`DID NOT RUN: module not found: ${file}`);
      process.exit(2);
    }
  }

  const repo = repoRoot();
  const source = signatureOfModule(pathToFileURL(join(repo, DESCRIPTORS_SRC_REL)).href, opts.bun);
  if (!source.ok) {
    console.error(`DID NOT RUN: could not evaluate ${DESCRIPTORS_SRC_REL} (${source.error})`);
    process.exit(2);
  }
  console.error(`[shipped-descriptors] source of truth ${DESCRIPTORS_SRC_REL}: ${signatureSummary(source.signature)}`);

  /** @type {Array<{label: string, module: string}>} */
  const candidates = opts.modules.map((file) => ({ label: relative(process.cwd(), resolve(file)), module: resolve(file) }));
  const temps = [];
  try {
    for (const tarball of opts.tarballs) {
      const dir = mkdtempSync(join(tmpdir(), "flair-shipped-"));
      temps.push(dir);
      const extracted = extractTarball(tarball, dir);
      if (!extracted.ok) {
        console.error(`DID NOT RUN: could not extract ${tarball} (${extracted.error})`);
        // Set the code and return through the `finally` below, which removes the
        // temp dirs: `process.exit()` terminates immediately and SKIPS `finally`,
        // so an extract failure leaked its `flair-shipped-*` dir (flair#1889).
        process.exitCode = 2;
        return;
      }
      const shipped = findShippedModules(join(dir, "package"));
      if (!shipped.length) {
        console.error(
          `[shipped-descriptors] ✗ ${tarball}: no ${join("dist", "<dir>", SHIPPED_REL_SUFFIX)} entry — ` +
            "the tarball ships no tool descriptors at all",
        );
        process.exitCode = 1;
        return;
      }
      for (const file of shipped) candidates.push({ label: `${tarball} → ${relative(dir, file)}`, module: file });
    }

    const failures = [];
    for (const { label, module } of candidates) {
      const actual = signatureOfModule(pathToFileURL(module).href, opts.bun);
      if (!actual.ok) {
        failures.push(`${label}: could not evaluate (${actual.error})`);
        continue;
      }
      const delta = diffSignatures(source.signature, actual.signature);
      if (!delta.digestMatches) {
        const detail = [
          delta.countDelta ? `count ${delta.countDelta > 0 ? "+" : ""}${delta.countDelta}` : "same count",
          delta.missing.length ? `missing ${delta.missing.join(", ")}` : "",
          delta.extra.length ? `unexpected ${delta.extra.join(", ")}` : "",
          delta.missing.length || delta.extra.length ? "" : "same names — a description/inputSchema changed",
        ]
          .filter(Boolean)
          .join("; ");
        failures.push(`${label}: ${signatureSummary(actual.signature)} diverges from the source of truth (${detail})`);
        continue;
      }
      console.error(`[shipped-descriptors] ✓ ${label}: ${signatureSummary(actual.signature)}`);
    }

    if (failures.length) {
      console.error(`[shipped-descriptors] FAILED ${failures.length} check(s):`);
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exitCode = 1;
      return;
    }
    console.error(`[shipped-descriptors] OK — ${candidates.length} shipped module(s) match the source of truth`);
  } finally {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? process.argv[1] : "";
if (invoked.endsWith("check-shipped-descriptors.mjs")) {
  await main();
}
