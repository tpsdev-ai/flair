/**
 * postinstall.cts — `npm install -g` PATH check (flair#1134).
 *
 * THIS IS THE POSTINSTALL ENTRY (`package.json` "postinstall" requires
 * dist/postinstall.cjs). It exists for exactly one case: a user-prefix
 * global install (prefix = ~/.npm-global or similar) where npm links the
 * `flair` bin into a directory that is not on PATH. The install "succeeds",
 * then `flair` is command-not-found, and the docs' one-command install claim
 * is a lie. This is the only surface that can reach the user at the moment
 * that happens — a first-run banner can never run, because the bin the user
 * would run is precisely what's unreachable.
 *
 * History note (#1078/#1008): the previous postinstall was removed because it
 * was a NO-OP (chmod +x on bins npm already marks executable) that cost an
 * install-script approval line. This one is not that: it does work no other
 * surface can, it is read-only (env + one existsSync — no network, no
 * writes), and it NEVER fails the install (every path swallows errors and
 * exits 0). Where lifecycle scripts are suppressed — `--ignore-scripts`,
 * bun without trustedDependencies, the fleet's tar-swap deploys (the #1078
 * path, which manages PATH itself) — `flair doctor` runs the same check.
 *
 * Delivery: npm ≥8 hides lifecycle-script output on success (it only shows
 * with --foreground-scripts or on failure), so printing to stderr alone
 * would be invisible exactly where it matters. We write to /dev/tty first —
 * that bypasses npm's captured pipes and lands on the interactive terminal —
 * and fall back to stderr (visible under --foreground-scripts, bun, older
 * npm; harmlessly buffered otherwise). No TTY (CI) ⇒ the fallback is the
 * only path, which is the right amount of noise for CI: none visible.
 *
 * Like cli-shim.cts this is CommonJS on purpose: it parses and runs on any
 * Node a user could have, and the ESM helper is loaded via dynamic import()
 * with every failure swallowed — a postinstall must never be the thing that
 * breaks an install.
 */

function writeToTty(text: string): boolean {
  // npm captures the script's stdout/stderr pipes; the controlling terminal
  // does not go through them. Best-effort, sync, closed either way.
  //
  // FLAIR_POSTINSTALL_NO_TTY: unit tests spawn this entry and assert on the
  // stderr fallback; without the knob, a dev running the suite from a real
  // terminal would have /dev/tty succeed — scribbling the banner over their
  // screen and blanking the stderr the test asserts on (flaky by
  // environment). The tty path's own coverage is the manual pty
  // verification recorded in the flair#1134 PR (`script`-wrapped npm i -g).
  if (process.env.FLAIR_POSTINSTALL_NO_TTY) return false;
  try {
    var fs = require("node:fs");
    var fd = fs.openSync("/dev/tty", "w");
    try {
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    return false;
  }
}

import("./install/global-bin-path.js")
  .then(function (mod) {
    try {
      var path = require("node:path");
      var message = mod.postinstallWarning({
        npmConfigGlobal: process.env.npm_config_global,
        npmConfigPrefix: process.env.npm_config_prefix,
        pathEnv: process.env.PATH,
        shell: process.env.SHELL,
        // __dirname is <pkg>/dist — the package root is one up.
        packageDir: path.resolve(__dirname, ".."),
      });
      if (message) {
        var banner = "\n@tpsdev-ai/flair postinstall:\n\n" + message + "\n";
        if (!writeToTty(banner)) console.error(banner);
      }
    } catch (e) {
      // Never fail the install over a diagnostic.
    }
  })
  .catch(function () {
    // Helper unloadable (ancient Node, partial install) — never fail the install.
  });
