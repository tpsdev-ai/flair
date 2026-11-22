#!/usr/bin/env node
// Shared embedding-readiness wait for CI lanes (flair#3052).
//
// Harper loads the embedding model lazily on the first embed and bounds each
// provider call at about 20 s, so a cold model answers a lane's first memory
// write with `503 memory_provider_timeout` ("nothing was written, retry").
// Retrying by ATTEMPT COUNT gives up too early: three attempts each end at the
// server's own bound, so the wait stops at ~62 s no matter how large the
// per-attempt budget is. This wait is bounded by TOTAL ELAPSED TIME instead,
// up to EMBEDDING_READY_DEADLINE_MS, and only that 503 is retried — any other
// answer means the provider is not merely cold, and fails at once.
//
// Used by test/smoke/helpers/flair-instance.ts (in-process) and by
// test/e2e-cli.sh (this file run directly under node) so every lane waits
// through one implementation.

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nacl from "tweetnacl";

export const EMBEDDING_READY_DEADLINE_MS = 180_000;
export const EMBEDDING_RETRY_BACKOFF_MS = 1_000;
/** A hard bound independent of the clock, so a stalled or misconfigured clock cannot loop forever. */
export const MAX_READINESS_ATTEMPTS = 100;
export const PROVIDER_TIMEOUT_STATUS = 503;
export const PROVIDER_TIMEOUT_ERROR = "memory_provider_timeout";

const OPS_TIMEOUT_MS = 10_000;

function defaultSleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * True only for the cold-model answer the wait exists to absorb: HTTP 503
 * carrying `memory_provider_timeout`. Every other status and body fails at once.
 */
export function isProviderTimeout(status, bodyText) {
  return status === PROVIDER_TIMEOUT_STATUS
    && typeof bodyText === "string"
    && bodyText.includes(PROVIDER_TIMEOUT_ERROR);
}

function neverReady(label, elapsedMs, attempts, lastDetail) {
  return new Error(
    `${label}: the embedding provider never became ready: no successful embedding ` +
    `within ${Math.round(elapsedMs)}ms across ${attempts} attempt(s); last: ${lastDetail}`,
  );
}

/**
 * Call `attempt(remainingMs)` until it answers ok, the deadline passes, or a
 * non-timeout answer arrives. `attempt` must apply `remainingMs` as its own
 * client bound so a hung provider cannot outlive the deadline.
 *
 * @returns {Promise<{elapsedMs: number, attempts: number}>}
 */
export async function awaitEmbeddingReady(opts) {
  const label = opts.label ?? "embedding readiness";
  const deadlineMs = opts.deadlineMs ?? EMBEDDING_READY_DEADLINE_MS;
  const backoffMs = opts.backoffMs ?? EMBEDDING_RETRY_BACKOFF_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_READINESS_ATTEMPTS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((message) => console.log(message));

  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  let attempts = 0;
  let lastDetail = "no attempt ran";

  while (attempts < maxAttempts) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    attempts += 1;

    let res;
    try {
      res = await opts.attempt(remaining);
    } catch (err) {
      lastDetail = `${err?.message ?? err}`;
      // A client bound that expired is the deadline being spent, not a
      // different answer from the provider; report it as never-ready.
      if (now() >= deadline) break;
      throw new Error(`${label}: embedding provider call failed: ${lastDetail}`);
    }

    if (res.ok) {
      const elapsedMs = Math.round(now() - startedAt);
      log(`${label}: embedding ready after ${elapsedMs}ms and ${attempts} attempt(s)`);
      return { elapsedMs, attempts };
    }

    const bodyText = await res.text().catch(() => "");
    lastDetail = `HTTP ${res.status} ${bodyText}`;
    if (!isProviderTimeout(res.status, bodyText)) {
      throw new Error(
        `${label}: embedding provider answered HTTP ${res.status}, not ${PROVIDER_TIMEOUT_ERROR}: ${bodyText}`,
      );
    }

    const wait = Math.min(backoffMs, Math.max(0, deadline - now()));
    if (wait > 0) await sleep(wait);
  }

  throw neverReady(label, now() - startedAt, attempts, lastDetail);
}

/** Record the warm-up duration in the job summary when CI provides one. */
export function recordStepSummary(label, result) {
  const dest = process.env.GITHUB_STEP_SUMMARY;
  if (!dest) return false;
  try {
    appendFileSync(dest, `- ${label}: embedding model ready in ${result.elapsedMs} ms after ${result.attempts} attempt(s)\n`);
    return true;
  } catch {
    return false;
  }
}

async function opsPost(opsUrl, authHeader, body, fetchImpl = fetch) {
  const json = JSON.stringify(body);
  const headers = { "Content-Type": "application/json" };
  if (authHeader) headers.Authorization = authHeader;
  const send = (withAuth) => fetchImpl(opsUrl, {
    method: "POST",
    headers: withAuth ? headers : { "Content-Type": "application/json" },
    body: json,
    signal: AbortSignal.timeout(OPS_TIMEOUT_MS),
  });
  let res = await send(true);
  // A Harper with authorizeLocal accepts a credential-less loopback call; the
  // smoke helper retries this way and so does this one.
  if (res.status === 401) res = await send(false);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`embedding warm-up ops ${body.operation} ${body.table}: HTTP ${res.status} ${text}`);
  }
  return text;
}

/** Create the throwaway agent a warm-up write needs (mirrors real registration). */
export async function createWarmAgent(opsUrl, authHeader, fetchImpl = fetch) {
  const id = `embedding-warmup-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const kp = nacl.sign.keyPair();
  const text = await opsPost(opsUrl, authHeader, {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{
      id,
      name: `Embedding warm-up ${id.slice(-8)}`,
      kind: "agent",
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      createdAt: new Date().toISOString(),
    }],
  }, fetchImpl);
  if (!text.includes("inserted")) {
    throw new Error(`embedding warm-up agent ${id}: unexpected ops response: ${text}`);
  }
  return id;
}

async function deleteWarmResidue(opsUrl, authHeader, agentId, memoryIds, fetchImpl) {
  // A failed row delete must not skip the agent delete, or the agent leaks.
  if (memoryIds.length > 0) {
    await opsPost(opsUrl, authHeader, {
      operation: "delete", database: "flair", table: "Memory", ids: memoryIds,
    }, fetchImpl).catch(() => {});
  }
  await opsPost(opsUrl, authHeader, {
    operation: "delete", database: "flair", table: "Agent", ids: [agentId],
  }, fetchImpl);
}

/**
 * Wait for one successful embedding on a real instance, through a throwaway
 * agent and memory row that are removed afterwards. Same write path a lane's
 * first memory write takes, so the model is warm before that write runs.
 *
 * @returns {Promise<{elapsedMs: number, attempts: number}>}
 */
export async function warmInstanceEmbeddings(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const label = opts.label ?? "embedding readiness";
  const agentId = await createWarmAgent(opts.opsUrl, opts.authHeader, fetchImpl);
  const memoryIds = [];
  try {
    return await awaitEmbeddingReady({
      label,
      deadlineMs: opts.deadlineMs,
      backoffMs: opts.backoffMs,
      maxAttempts: opts.maxAttempts,
      now: opts.now,
      sleep: opts.sleep,
      log: opts.log,
      attempt: (remainingMs) => {
        const memId = `${agentId}-warmup-${Date.now()}-${randomBytes(4).toString("hex")}`;
        memoryIds.push(memId);
        return fetchImpl(`${opts.baseUrl}/Memory/${encodeURIComponent(memId)}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(opts.authHeader ? { Authorization: opts.authHeader } : {}),
          },
          body: JSON.stringify({
            id: memId,
            agentId,
            content: `embedding warm-up ${memId}`,
            type: "memory",
            durability: "ephemeral",
            createdAt: new Date().toISOString(),
          }),
          // The client bound is what remains of the deadline, so a hung
          // provider cannot outlive it.
          signal: AbortSignal.timeout(Math.max(1, remainingMs)),
        });
      },
    });
  } finally {
    // Never leak the warm-up agent or its rows, even on failure.
    await deleteWarmResidue(opts.opsUrl, opts.authHeader, agentId, memoryIds, fetchImpl).catch(() => {});
  }
}

function argValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** Config for the command-line form; credentials come from the environment, never argv. */
export function warmCliConfig(argv = process.argv.slice(2), env = process.env) {
  const baseUrl = (argValue(argv, "--base-url") ?? env.FLAIR_URL ?? env.FLAIR_TEST_URL ?? "http://127.0.0.1:9926")
    .replace(/\/$/, "");
  const httpPort = Number(new URL(baseUrl).port || 9926);
  const opsUrl = argValue(argv, "--ops-url") ?? env.FLAIR_OPS_URL ?? `http://127.0.0.1:${httpPort - 1}`;
  const label = argValue(argv, "--label") ?? "embedding readiness";
  const rawDeadline = argValue(argv, "--deadline-ms");
  const deadlineMs = rawDeadline === undefined ? EMBEDDING_READY_DEADLINE_MS : Number(rawDeadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`--deadline-ms must be a positive number, got ${JSON.stringify(rawDeadline)}`);
  }
  const adminUser = env.FLAIR_ADMIN_USER ?? "admin";
  const adminPass = env.FLAIR_ADMIN_PASS ?? "admin123";
  return {
    baseUrl,
    opsUrl,
    label,
    deadlineMs,
    authHeader: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`,
  };
}

async function main(argv) {
  const config = warmCliConfig(argv);
  const result = await warmInstanceEmbeddings(config);
  recordStepSummary(config.label, result);
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
