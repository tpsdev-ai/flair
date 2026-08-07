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

  // Verify the Flair application is actually loaded, not just that Harper
  // is listening. Harper's /health returns 200 as soon as the server is up,
  // but the Flair app may not be registered yet (e.g. no build artifacts).
  // Probing a Flair-owned route catches this: a loaded app returns non-404;
  // an absent app returns 404 from Harper's catch-all.
  await waitForAppLoaded(harper.httpURL);

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

/**
 * Poll a Flair-owned route until it returns a non-404 response, confirming
 * the Flair application is loaded and serving requests. Times out after 30s.
 */
async function waitForAppLoaded(httpURL, timeoutMs = 30_000) {
  const url = `${httpURL}/Memory`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const elapsed = Date.now() - (deadline - timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2000) });
      if (res.status !== 404) {
        console.error(`[boot-harper] app loaded: ${url} → ${res.status} (attempt ${attempt}, ${elapsed}ms)`);
        return;
      }
      console.error(`[boot-harper] app not yet loaded: ${url} → 404 (attempt ${attempt}, ${elapsed}ms)`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.error(`[boot-harper] app probe error: ${url} → ${msg} (attempt ${attempt}, ${elapsed}ms)`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(
    `Flair application not loaded at ${httpURL} after ${timeoutMs}ms ` +
    `(${attempt} attempts). The Flair app must be built before running ` +
    `integration tests — Harper is up but /Memory returns 404.`,
  );
}

main().catch((err) => {
  console.error("boot-harper failed:", err);
  process.exit(1);
});
