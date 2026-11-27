/**
 * Records every path the CLI reads or opens, and every fetch it sends, when the
 * matching env var names a log file. Used by the agent-key-path tests: a run
 * that refuses an agent id before building a key path leaves both logs empty
 * for the keys directory and the planted escape path.
 */
const fs = require("node:fs");
const { appendFileSync } = fs;

const readLog = process.env.FLAIR_TEST_KEY_READ_LOG;
if (readLog) {
  for (const name of ["readFileSync", "openSync"]) {
    const original = fs[name];
    fs[name] = function (path, ...args) {
      if (typeof path === "string") appendFileSync(readLog, `${path}\n`);
      return original.call(this, path, ...args);
    };
  }
  require("node:module").syncBuiltinESMExports();
}

const fetchLog = process.env.FLAIR_TEST_FETCH_LOG;
if (fetchLog) {
  globalThis.fetch = async (input, init) => {
    let path = "";
    try {
      path = new URL(String(input)).pathname;
    } catch {
      path = "<unparseable>";
    }
    appendFileSync(fetchLog, `${path}\n`);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}
