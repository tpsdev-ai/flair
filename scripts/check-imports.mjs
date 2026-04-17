#!/usr/bin/env node
// Walk a dist directory and verify every *.js file can be dynamically imported
// without ERR_MODULE_NOT_FOUND. Run per file in a subprocess so CLI entrypoints
// (which execute `program.parse()` at top level) don't pollute or terminate
// this runner.
//
// Intended use in CI: run against the INSTALLED tarball's dist/ so relative
// imports that don't survive the npm `files` manifest fail fast. The 0.5.3
// hotfix existed because dist/cli.js imported ../resources/federation-crypto.js
// and `resources/` wasn't in the published tarball — this check would have
// caught it before publish.
import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

const target = resolve(process.argv[2] ?? "dist");
const files = walk(target);
if (files.length === 0) {
  console.error(`No .js files under ${target}`);
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const url = pathToFileURL(f).href;
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`],
      { stdio: "pipe", timeout: 15_000 },
    );
  } catch (err) {
    const stderr = (err.stderr ?? Buffer.alloc(0)).toString();
    // We only fail on module-resolution errors. Any runtime behavior (including
    // clean exits or unrelated errors from top-level code) is out of scope for
    // this check.
    if (
      stderr.includes("ERR_MODULE_NOT_FOUND") ||
      stderr.includes("Cannot find module") ||
      stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")
    ) {
      console.error(`FAIL: ${f}`);
      console.error(stderr.trim().split("\n").slice(0, 10).map(l => `  ${l}`).join("\n"));
      failed++;
    }
  }
}

console.log(`${files.length} file(s) checked, ${failed} import failure(s)`);
process.exit(failed > 0 ? 1 : 0);
