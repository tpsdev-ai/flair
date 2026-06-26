#!/usr/bin/env node
/**
 * cli-shim.cts — Node-version PREFLIGHT for the Flair CLI.
 *
 * THIS IS THE BIN ENTRY (`package.json` "bin": { "flair": "dist/cli-shim.cjs" }).
 *
 * Why a separate CommonJS file instead of a guard inside cli.ts:
 *   The real CLI (dist/cli.js) is an ES module. In ESM, every top-level
 *   `import` is HOISTED and the whole module graph is LINKED + EVALUATED before
 *   the first statement in the file body runs. Flair's deps (harper-fabric-
 *   embeddings requires Node >=22, @harperfast/harper / commander require >=20)
 *   fail to load on an older engine — so a Node-version check placed even at the
 *   very top of cli.ts never executes: the import graph crashes first. That is
 *   exactly the silent-onboarding-failure bug (a Harper dev got zero output and
 *   no ~/.flair on an old Node, fixed only by upgrading).
 *
 *   CommonJS evaluates top-to-bottom and `require()`/`import()` are evaluated
 *   lazily — so the version check below runs and prints BEFORE anything tries to
 *   load the ESM CLI or any modern dependency. Because every Node since v0.x
 *   parses and runs CommonJS, this shim is guaranteed to run and print on the
 *   oldest Node a developer could plausibly have.
 *
 *   The check itself deliberately uses ONLY ancient-safe syntax — `var`, plain
 *   functions, string `.split`/`parseInt`, `console.error`, `process.exit`. No
 *   top-level await, no optional chaining, no template literals reaching
 *   modern-only APIs — so the guard can never become the thing that fails to
 *   parse.
 */

// ── Node-version preflight (must stay parse-safe + runtime-safe on old Node) ──
var MIN_NODE_MAJOR = 22;

function flairCurrentNodeMajor() {
  // process.versions.node is e.g. "18.20.4"; take the leading integer.
  var raw = (process && process.versions && process.versions.node) || "0";
  return parseInt(String(raw).split(".")[0], 10) || 0;
}

var flairNodeMajor = flairCurrentNodeMajor();

if (flairNodeMajor < MIN_NODE_MAJOR) {
  // Plain string concatenation — no template literals, no chalk, nothing that
  // could itself trip on an old engine.
  console.error("");
  console.error("  Flair requires Node.js >= " + MIN_NODE_MAJOR + ".");
  console.error("  You are running Node.js " + (process.versions && process.versions.node ? process.versions.node : "(unknown)") + ".");
  console.error("");
  console.error("  Please upgrade Node and try again:");
  console.error("    https://nodejs.org/  (or use nvm / fnm / volta)");
  console.error("");
  process.exit(1);
}

// Node is new enough — hand off to the real ESM CLI. Dynamic import() from
// CommonJS is the supported ESM-from-CJS bridge. We only reach this line on a
// supported Node, so the import() expression is never evaluated on an engine
// that can't load the ESM graph.
import("./cli.js")
  .then(function (mod) {
    if (mod && typeof mod.runCli === "function") {
      return mod.runCli();
    }
    // Older builds auto-ran on import via import.meta.main; nothing to call.
    return undefined;
  })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
