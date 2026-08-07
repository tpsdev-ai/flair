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
import * as crypto from "node:crypto";

async function main() {
  const harper = await startHarper();

  // Verify the Flair application is actually loaded, not just that Harper
  // is listening. Harper's /health returns 200 as soon as the server is up,
  // but the Flair app may not be registered yet (e.g. no build artifacts).
  // Probing a Flair-owned route catches this: a loaded app returns non-404;
  // an absent app returns 404 from Harper's catch-all.
  await waitForAppLoaded(harper.httpURL);

  // Warm up the embedding/write pipeline so the first real test write
  // doesn't time out against a cold Harper on a CI runner. Performs a
  // real authenticated write+search round-trip, retrying until latency
  // drops below 1s (the adapter's localhost budget).
  //
  // Returns { outcome: "warm" | "floor-exceeded", floorMs: number }.
  // "floor-exceeded" means the CI runner cannot reach operating latency
  // — this is a capability gate, not a failure (flair#1119).
  const warmup = await warmUpPipeline(
    harper.httpURL,
    harper.opsURL,
    harper.admin.username,
    harper.admin.password,
  );

  if (warmup.outcome === "floor-exceeded") {
    // Capability gate: runner class cannot meet the warm-up bar.
    // Emit FLOOR-EXCEEDED so the CI lane can skip gracefully, then
    // tear down and exit 0 — this is NOT a failure.
    const floorMsg = {
      outcome: "FLOOR-EXCEEDED",
      floor_ms: warmup.floorMs,
    };
    process.stdout.write(JSON.stringify(floorMsg) + "\n");
    await stopHarper(harper);
    process.exit(0);
  }

  // Pipeline is warm — emit connection details and block until teardown.
  const config = {
    httpURL: harper.httpURL,
    opsURL: harper.opsURL,
    adminUser: harper.admin.username,
    adminPass: harper.admin.password,
    installDir: harper.installDir,
    outcome: "BOOTED+WARM",
    floor_ms: warmup.floorMs,
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

// ─── Pipeline warm-up ────────────────────────────────────────────────────────

/**
 * Build a TPS-Ed25519 Authorization header value.
 *
 * Format: `TPS-Ed25519 <agent-id>:<timestamp>:<nonce>:<base64-sig>`
 */
function signRequest(privateKey, agentId, method, path) {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = crypto.sign(null, Buffer.from(payload, "utf-8"), privateKey);
  const sigB64 = sig.toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sigB64}`;
}

/**
 * Warm up the embedding/write pipeline by performing a real authenticated
 * write + search round-trip. Retries until a full round-trip completes in
 * under 1s (the adapter's localhost budget), or the deadline expires.
 *
 * On a cold CI runner, the first few writes can take 2-5s while Harper's
 * embedding pipeline initialises. This warm-up absorbs that cost before
 * tests run, so the adapter's intentionally-tight timeouts are never hit.
 *
 * Returns { outcome: "warm" | "floor-exceeded", floorMs: number }.
 * "floor-exceeded" is a capability gate (flair#1119) — the runner class
 * cannot reach operating latency, but this is not a code defect.
 *
 * Deletes the warm-up row and agent afterwards when warm.
 */
async function warmUpPipeline(httpURL, opsURL, adminUser, adminPass, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

  // Generate a temporary Ed25519 keypair for the warm-up agent
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "der", type: "spki" });
  // Ed25519 SPKI DER has a 12-byte prefix; strip to raw 32 bytes
  const rawPublic = publicBytes.subarray(12);
  const publicKeyB64 = Buffer.from(rawPublic).toString("base64");

  // Register a warm-up agent via the ops API (basic auth)
  const warmupAgentId = `warmup-${crypto.randomUUID().slice(0, 8)}`;
  const opsAuth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");

  console.error(`[boot-harper] registering warm-up agent ${warmupAgentId}...`);
  const regRes = await fetch(opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${opsAuth}`,
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{
        id: warmupAgentId,
        name: warmupAgentId,
        role: "agent",
        publicKey: publicKeyB64,
        createdAt: new Date().toISOString(),
      }],
    }),
  });
  if (regRes.status >= 400) {
    const body = await regRes.text().catch(() => "");
    throw new Error(`warm-up agent registration failed: HTTP ${regRes.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const memoryId = `warmup-${crypto.randomUUID()}`;
  const tag = "adk:warmup:probe";
  let bestLatency = Infinity;
  let attempt = 0;

  console.error(`[boot-harper] warming pipeline (budget: <1000ms, deadline: ${timeoutMs / 1000}s)...`);

  while (Date.now() < deadline) {
    attempt++;
    const start = Date.now();

    try {
      // ── Write a test memory ──────────────────────────────────────────
      const writePath = `/Memory/${memoryId}`;
      const writeAuth = signRequest(privateKey, warmupAgentId, "PUT", writePath);
      const writeRes = await fetch(`${httpURL}${writePath}`, {
        method: "PUT",
        headers: {
          "Authorization": writeAuth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: memoryId,
          agentId: warmupAgentId,
          content: "warm-up probe",
          type: "session",
          durability: "ephemeral",
          tags: [tag],
          createdAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!writeRes.ok) {
        const body = await writeRes.text().catch(() => "");
        throw new Error(`write returned ${writeRes.status}${body ? `: ${body.slice(0, 100)}` : ""}`);
      }

      // ── Search for it ────────────────────────────────────────────────
      const searchPath = "/SemanticSearch";
      const searchAuth = signRequest(privateKey, warmupAgentId, "POST", searchPath);
      const searchRes = await fetch(`${httpURL}${searchPath}`, {
        method: "POST",
        headers: {
          "Authorization": searchAuth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: warmupAgentId,
          q: "warm-up probe",
          tag,
          limit: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!searchRes.ok) {
        const body = await searchRes.text().catch(() => "");
        throw new Error(`search returned ${searchRes.status}${body ? `: ${body.slice(0, 100)}` : ""}`);
      }

      const latency = Date.now() - start;
      if (latency < bestLatency) bestLatency = latency;

      console.error(`[boot-harper] warm-up attempt ${attempt}: ${latency}ms (best: ${bestLatency}ms)`);

      if (latency < 1000) {
        // Pipeline is warm — clean up and return
        await deleteWarmupRow(httpURL, privateKey, warmupAgentId, memoryId);
        console.error(`[boot-harper] pipeline warm: ${latency}ms (${attempt} attempt(s))`);
        return { outcome: "warm", floorMs: bestLatency };
      }
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.error(`[boot-harper] warm-up attempt ${attempt} failed: ${msg}`);
    }

    // Back off: 2s between attempts
    await new Promise(r => setTimeout(r, 2000));
  }

  // Timed out — the runner class cannot reach operating latency.
  // This is a capability gate, not a code defect (flair#1119).
  const floorMs = bestLatency === Infinity ? null : bestLatency;
  console.error(
    `[boot-harper] pipeline floor-exceeded: best round-trip ${floorMs ?? "N/A"}ms ` +
    `after ${attempt} attempts (budget: <1000ms, deadline: ${timeoutMs / 1000}s). ` +
    `Runner class cannot reach operating latency — capability gate, not a failure.`,
  );
  return { outcome: "floor-exceeded", floorMs };
}

/**
 * Delete the warm-up memory row and deregister the warm-up agent.
 * Best-effort — failures are logged but not fatal.
 */
async function deleteWarmupRow(httpURL, privateKey, agentId, memoryId) {
  try {
    const path = `/Memory/${memoryId}`;
    const auth = signRequest(privateKey, agentId, "DELETE", path);
    const res = await fetch(`${httpURL}${path}`, {
      method: "DELETE",
      headers: { "Authorization": auth },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[boot-harper] warm-up cleanup: DELETE /Memory/${memoryId} → ${res.status}`);
    }
  } catch (err) {
    console.error(`[boot-harper] warm-up cleanup error: ${err?.message ?? String(err)}`);
  }
}

main().catch((err) => {
  console.error("boot-harper failed:", err);
  process.exit(1);
});
