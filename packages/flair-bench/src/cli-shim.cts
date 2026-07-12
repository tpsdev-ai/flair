#!/usr/bin/env node
/**
 * cli-shim.cts — Node-version PREFLIGHT for the flair-bench CLI.
 *
 * THIS IS THE BIN ENTRY (`package.json` "bin": { "flair-bench": "dist/cli-shim.cjs" }).
 *
 * Same pattern as the root package's src/cli-shim.cts and
 * packages/flair-mcp/src/mcp-shim.cts — see either for the full rationale.
 * Short version: the real CLI (dist/cli.js) is an ES module, and ESM hoists
 * + links + evaluates the whole import graph before the first statement in
 * the file body runs — so a Node-version check inside cli.ts itself would
 * never execute on a too-old Node (node-llama-cpp requires a modern engine
 * and fails to load first). This file is CommonJS, which evaluates
 * top-to-bottom, so the version check below is guaranteed to run and print
 * before anything tries to load the ESM CLI or node-llama-cpp.
 *
 * Deliberately ancient-safe syntax only — `var`, plain functions, string
 * `.split`/`parseInt`, `console.error`, `process.exit`. No top-level await,
 * no optional chaining reaching modern-only APIs.
 */

var MIN_NODE_MAJOR = 22;

function flairBenchCurrentNodeMajor() {
  var raw = (process && process.versions && process.versions.node) || "0";
  return parseInt(String(raw).split(".")[0], 10) || 0;
}

var flairBenchNodeMajor = flairBenchCurrentNodeMajor();

if (flairBenchNodeMajor < MIN_NODE_MAJOR) {
  console.error("");
  console.error("  flair-bench requires Node.js >= " + MIN_NODE_MAJOR + ".");
  console.error("  You are running Node.js " + (process.versions && process.versions.node ? process.versions.node : "(unknown)") + ".");
  console.error("");
  console.error("  Please upgrade Node and try again:");
  console.error("    https://nodejs.org/  (or use nvm / fnm / volta)");
  console.error("");
  process.exit(1);
}

import("./cli.js")
  .then(function (mod) {
    if (mod && typeof mod.runCli === "function") {
      return mod.runCli();
    }
    return undefined;
  })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
