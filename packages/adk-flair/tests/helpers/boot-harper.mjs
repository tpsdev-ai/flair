#!/usr/bin/env node
/**
 * Boot an ephemeral Harper instance and emit its connection details as JSON.
 *
 * Usage:
 *   node boot-harper.mjs
 *
 * Outputs one JSON line to stdout with { httpURL, opsURL, adminUser, adminPass },
 * then blocks until stdin closes or SIGTERM arrives, at which point it tears
 * down Harper and exits.
 *
 * The Python conftest spawns this as a subprocess, reads the JSON line, and
 * kills the process to trigger teardown.
 */
import { startHarper, stopHarper } from "../../../../test/helpers/harper-lifecycle";

async function main() {
  const harper = await startHarper();

  // Emit connection details as one JSON line (installDir included so the
  // caller can clean up the ephemeral tree after stopping Harper).
  const config = {
    httpURL: harper.httpURL,
    opsURL: harper.opsURL,
    adminUser: harper.admin.username,
    adminPass: harper.admin.password,
    installDir: harper.installDir,
  };
  process.stdout.write(JSON.stringify(config) + "\n");

  // Block until parent signals teardown (stdin close or SIGTERM)
  await new Promise((resolve) => {
    process.stdin.on("end", resolve);
    process.on("SIGTERM", resolve);
    process.on("SIGINT", resolve);
  });

  await stopHarper(harper);
}

main().catch((err) => {
  console.error("boot-harper failed:", err);
  process.exit(1);
});
