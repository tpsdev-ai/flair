#!/usr/bin/env node
/**
 * mcp-shim.cts — Node-version PREFLIGHT for the Flair MCP server.
 *
 * THIS IS THE BIN ENTRY (`package.json` "bin": { "flair-mcp": "dist/mcp-shim.cjs" }).
 *
 * Why a separate CommonJS file instead of a guard inside index.ts:
 *   The real MCP server (dist/index.js) is an ES module. In ESM, every top-level
 *   `import` is HOISTED and the whole module graph is LINKED + EVALUATED before
 *   the first statement in the file body runs. flair-mcp's deps (@modelcontext-
 *   protocol/sdk, @tpsdev-ai/flair-client and its transitive deps) require a
 *   modern engine, so on an older Node the import graph fails to load — and a
 *   Node-version check placed even at the very top of index.ts never executes:
 *   the import graph crashes first. That is exactly the silent-failure bug — a
 *   user wiring `npx -y @tpsdev-ai/flair-mcp` on an old Node gets zero output and
 *   a dead MCP server, with no actionable signal (the same exposure flair's CLI
 *   had before #524).
 *
 *   CommonJS evaluates top-to-bottom and `require()`/`import()` are evaluated
 *   lazily — so the version check below runs and prints BEFORE anything tries to
 *   load the ESM server or any modern dependency. Because every Node since v0.x
 *   parses and runs CommonJS, this shim is guaranteed to run and print on the
 *   oldest Node a user could plausibly have.
 *
 *   The check itself deliberately uses ONLY ancient-safe syntax — `var`, plain
 *   functions, string `.split`/`parseInt`, `console.error`, `process.exit`. No
 *   top-level await, no optional chaining, no template literals reaching
 *   modern-only APIs — so the guard can never become the thing that fails to
 *   parse.
 */

// ── Node-version preflight (must stay parse-safe + runtime-safe on old Node) ──
var MIN_NODE_MAJOR = 22;

function flairMcpCurrentNodeMajor() {
  // process.versions.node is e.g. "18.20.4"; take the leading integer.
  var raw = (process && process.versions && process.versions.node) || "0";
  return parseInt(String(raw).split(".")[0], 10) || 0;
}

var flairMcpNodeMajor = flairMcpCurrentNodeMajor();

if (flairMcpNodeMajor < MIN_NODE_MAJOR) {
  // Plain string concatenation — no template literals, no chalk, nothing that
  // could itself trip on an old engine.
  console.error("");
  console.error("  flair-mcp requires Node.js >= " + MIN_NODE_MAJOR + ".");
  console.error("  You are running Node.js " + (process.versions && process.versions.node ? process.versions.node : "(unknown)") + ".");
  console.error("");
  console.error("  Please upgrade Node and try again:");
  console.error("    https://nodejs.org/  (or use nvm / fnm / volta)");
  console.error("");
  process.exit(1);
}

// Node is new enough — hand off to the real ESM MCP server. Dynamic import()
// from CommonJS is the supported ESM-from-CJS bridge. We only reach this line on
// a supported Node, so the import() expression is never evaluated on an engine
// that can't load the ESM graph.
import("./index.js")
  .then(function (mod) {
    if (mod && typeof mod.runMcp === "function") {
      return mod.runMcp();
    }
    // Older builds auto-ran on import via import.meta.main; nothing to call.
    return undefined;
  })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
