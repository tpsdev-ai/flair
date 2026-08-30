/**
 * flair#1450 powered-check parent.
 *
 * Boots a real Harper via startHarper, writes { harperPid, parentPid, installDir }
 * to the path in argv[2], then stays alive. SIGTERM/SIGINT → stopHarper (clean).
 * SIGKILL (the incident) skips teardown; the child's orphan-exit preload must
 * then exit the Harper. Identifies the child by the pid startHarper returned,
 * never by process name.
 */
import { writeFileSync } from "node:fs";
import { startHarper, stopHarper } from "./harper-lifecycle.ts";

const outPath = process.argv[2];
if (!outPath) {
  console.error("usage: harper-orphan-parent.ts <status-file>");
  process.exit(2);
}

const harper = await startHarper();
writeFileSync(
  outPath,
  JSON.stringify({
    harperPid: harper.process?.pid ?? null,
    parentPid: process.pid,
    installDir: harper.installDir,
  }) + "\n",
);

const teardown = async () => {
  await stopHarper(harper);
  process.exit(0);
};
process.on("SIGTERM", teardown);
process.on("SIGINT", teardown);

await new Promise(() => {});
