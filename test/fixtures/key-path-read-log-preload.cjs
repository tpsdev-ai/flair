/**
 * Records the path argument of each readFileSync and openSync call (string,
 * Buffer or file: URL), and the path of each global fetch request (string, URL
 * or Request input), when the matching env var names a log file. Used by the
 * agent-key-path tests: a run that refuses an agent id before building a key
 * path leaves both logs empty for the keys directory and the planted escape
 * path.
 */
const fs = require("node:fs");
const { appendFileSync } = fs;

/** The path an fs call names, for a string, Buffer or URL argument. */
function recordedPath(path) {
  if (typeof path === "string") return path;
  if (Buffer.isBuffer(path)) return path.toString();
  if (path instanceof URL) return path.href;
  return null;
}

const readLog = process.env.FLAIR_TEST_KEY_READ_LOG;
if (readLog) {
  for (const name of ["readFileSync", "openSync"]) {
    const original = fs[name];
    fs[name] = function (path, ...args) {
      const shown = recordedPath(path);
      if (shown !== null) appendFileSync(readLog, `${shown}\n`);
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
      const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      path = new URL(raw).pathname;
    } catch {
      path = "<unparseable>";
    }
    appendFileSync(fetchLog, `${path}\n`);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}
