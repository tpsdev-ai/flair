/**
 * The stub Harper that test/unit/launchd-2040-command-level.test.ts starts from
 * its temporary package tree (flair#2281).
 *
 * The stub must end on its own when the test process that started it is gone: a
 * tool timeout, Ctrl-C or a CI step timeout kills the test runner, so the file's
 * `afterEach` does not run, and the stub is otherwise re-parented to PID 1 and
 * keeps running after its tree is deleted. Two independent exits, either
 * sufficient:
 *
 *   1. `STUB_OWNER_PID` names the test process (or, in an owner-death test, a
 *      stand-in for it); a poll of it is the shutdown heartbeat. The stub exits
 *      the first time that pid is gone. This also covers a stub the launchctl
 *      shim started: the shim's parent relationship does not reliably identify
 *      the owning test runner.
 *   2. `STUB_MAX_LIFETIME_MS` is a hard backstop, set well above the test's
 *      budget.
 *
 * `stubLifetimeEnv()` arms both; callers merge it into the stub's environment.
 * A stub missing either variable exits with `STUB_LIFETIME_UNSET` before it serves.
 */

/** Hard backstop for a stub whose owner poll would not otherwise fire. */
export const STUB_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** The environment that arms a stub's two exits against `ownerPid`. */
export function stubLifetimeEnv(ownerPid: number): Record<string, string> {
  return {
    STUB_OWNER_PID: String(ownerPid),
    STUB_MAX_LIFETIME_MS: String(STUB_MAX_LIFETIME_MS),
  };
}

export const STUB_HARPER = `
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Fail closed: a stub missing either exit from this file's header stops here, before it serves.
const ownerPid = Number(process.env.STUB_OWNER_PID);
const maxLifetimeMs = Number(process.env.STUB_MAX_LIFETIME_MS);
if (!Number.isInteger(ownerPid) || ownerPid <= 1 || !Number.isInteger(maxLifetimeMs) || maxLifetimeMs <= 0) {
  process.stderr.write("STUB_LIFETIME_UNSET: this stub needs STUB_OWNER_PID and STUB_MAX_LIFETIME_MS; merge stubLifetimeEnv() into its environment\\n");
  process.exit(1);
}
const root = process.env.ROOTPATH;
const port = Number(((process.env.HTTP_PORT ?? "0").match(/(\\d+)$/) ?? [])[1] ?? 0);
if (process.env.STUB_START_LOG) appendFileSync(process.env.STUB_START_LOG, process.pid + "\\n");
const http = createServer((_q, r) => {
  r.writeHead(200, { "content-type": "application/json" });
  r.end('{"ok":true,"version":"0.57.0","buildCommit":null,"searchReady":true}');
});
// A real Harper takes seconds to boot: STUB_START_DELAY_MS holds the bind and
// the hdb.pid write back while the process itself is already running.
// STUB_PIDFILE_FIRST writes hdb.pid AND opens the operations socket at once,
// BEFORE the (delayed) HTTP bind: a process whose pid file names it, and whose
// ops socket is up, while its HTTP port still refuses.
const openOpsSocket = () => {
  try { rmSync(join(root, "operations-server"), { force: true }); } catch {}
  createNetServer((s) => s.end()).listen(join(root, "operations-server"));
};
if (process.env.STUB_PIDFILE_FIRST) {
  writeFileSync(join(root, "hdb.pid"), String(process.pid));
  openOpsSocket();
  appendFileSync(join(root, "stub-events.log"), "pidfile\\n");
}
const serve = () => http.listen(port, "127.0.0.1", () => {
  if (process.env.STUB_PIDFILE_FIRST) appendFileSync(join(root, "stub-events.log"), "bound\\n");
  if (!process.env.STUB_NO_PIDFILE) writeFileSync(join(root, "hdb.pid"), String(process.pid));
  writeFileSync(join(root, "stub-port"), String(http.address().port));
  if (!process.env.STUB_PIDFILE_FIRST) openOpsSocket();
});
const startDelayMs = Number(process.env.STUB_START_DELAY_MS ?? 0);
if (startDelayMs > 0) setTimeout(serve, startDelayMs); else serve();
// The two exits from this file's header. Independent of the SIGTERM handler
// below, which a stub with STUB_HOLD_ON_SIGTERM deliberately ignores.
setInterval(() => {
  try { process.kill(ownerPid, 0); } catch { process.exit(0); }
}, 250);
setTimeout(() => process.exit(0), maxLifetimeMs);
process.on("SIGTERM", () => {
  appendFileSync(join(root, "signals.log"), "SIGTERM " + process.pid + "\\n");
  try { if (readFileSync(join(root, "hdb.pid"), "utf-8").trim() === String(process.pid)) rmSync(join(root, "hdb.pid")); } catch {}
  if (!process.env.STUB_HOLD_ON_SIGTERM) process.exit(0);
});
`;
