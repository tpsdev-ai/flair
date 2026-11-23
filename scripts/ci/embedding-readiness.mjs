#!/usr/bin/env node
// Shared embedding-readiness wait for CI lanes (flair#3052).
//
// Harper loads the embedding model lazily on the first embed and bounds each
// provider call at about 20 s, so a cold model can answer a lane's first memory
// write with `503 memory_provider_timeout` ("nothing was written, retry").
// Retrying by ATTEMPT COUNT gives up too early: three calls that each time out
// at the default provider bound, plus two retry pauses, take about 62 s, no
// matter how large the per-attempt budget is. Here elapsed time and a hard
// attempt cap govern retries and acceptance instead: the configured deadline
// is EMBEDDING_READY_DEADLINE_MS (the CLI can override it with --deadline-ms),
// measured on a monotonic clock. This is a client-side policy: an in-flight
// request or sleep can still settle after the deadline, and its answer is then
// refused.
//
// Retry policy. Among non-2xx Memory responses, only a 503 whose JSON `error`
// field is `memory_provider_timeout` is retried; any other non-2xx status or
// error field, or an unparseable body, fails at once. A 2xx is retried too
// when the read-back below fails or does not confirm a stored vector and model
// stamp. A Memory PUT that throws a client `TimeoutError`, or throws at or after
// the deadline, ends the wait as never-ready; any other thrown PUT error fails at
// once. A read-back that fails or throws is retried while time remains. This is a policy
// over response shapes; it does not diagnose why the server answered. The
// operations-API calls (agent create, read-back, deletes) separately retry a
// 401 once without credentials (see opsPost).
//
// READY means a stored embedding, not merely a 2xx write: getEmbedding() can
// return null on a backend failure and Memory PUT can still succeed without a
// vector, so the wait reads the warm-up row back and requires its `embedding`
// to be a nonempty array and its `embeddingModel` stamp a nonempty string
// before it reports ready.
//
// Used by test/smoke/helpers/flair-instance.ts (in-process) and by
// test/e2e-cli.sh (this file run directly under node), so the smoke and CLI
// E2E paths wait through one implementation.

import { randomBytes } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";

export const EMBEDDING_READY_DEADLINE_MS = 180_000;
export const EMBEDDING_RETRY_BACKOFF_MS = 1_000;
/** A hard bound independent of the clock, so a stalled or misconfigured clock cannot loop forever. */
export const MAX_READINESS_ATTEMPTS = 100;
export const PROVIDER_TIMEOUT_STATUS = 503;
export const PROVIDER_TIMEOUT_ERROR = "memory_provider_timeout";

export const OPS_TIMEOUT_MS = 10_000;

function defaultSleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Monotonic elapsed-time clock: a wall-clock change cannot stretch the wait. */
function defaultNow() {
  return performance.now();
}

/**
 * True only for the non-2xx response shape the wait retries: HTTP 503 whose
 * JSON `error` field is exactly `memory_provider_timeout`. The shape is a retry
 * signal, not proof that the model is cold. A 503 that merely mentions the
 * code elsewhere in its body, or whose body is not JSON, does not match and is
 * not retried.
 */
export function isProviderTimeout(status, bodyText) {
  if (status !== PROVIDER_TIMEOUT_STATUS || typeof bodyText !== "string") return false;
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return false;
  }
  return body !== null && typeof body === "object" && body.error === PROVIDER_TIMEOUT_ERROR;
}

function neverReady(label, elapsedMs, attempts, lastDetail) {
  return new Error(
    `${label}: the embedding provider never became ready: no successful embedding ` +
    `within ${Math.round(elapsedMs)}ms across ${attempts} attempt(s); last: ${lastDetail}`,
  );
}

/**
 * Call `attempt(remainingMs)` until a 2xx is confirmed, the deadline passes,
 * the attempt cap is reached, or a non-2xx answer that `isProviderTimeout`
 * does not match arrives. `remainingMs` is a CLIENT-SIDE wait bound: the
 * caller applies it to its own request. An in-process timeout cannot preempt a
 * provider that never yields the event loop (resources/memory-write-lock.ts).
 * An optional `confirm(res, remainingMs)` must approve each 2xx before it
 * counts as ready; a rejection or a thrown read-back retries within the
 * deadline.
 *
 * @returns {Promise<{elapsedMs: number, attempts: number}>}
 */
export async function awaitEmbeddingReady(opts) {
  const label = opts.label ?? "embedding readiness";
  const deadlineMs = opts.deadlineMs ?? EMBEDDING_READY_DEADLINE_MS;
  const backoffMs = opts.backoffMs ?? EMBEDDING_RETRY_BACKOFF_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_READINESS_ATTEMPTS;
  const now = opts.now ?? defaultNow;
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
      // `AbortSignal.timeout` bounds the caller's own request and can fire
      // just before the monotonic deadline is read. Treat a TimeoutError as
      // the deadline being spent rather than a different answer from the
      // provider; report it as never-ready.
      if (err?.name === "TimeoutError" || now() >= deadline) break;
      throw new Error(`${label}: embedding provider call failed: ${lastDetail}`);
    }

    if (res.ok) {
      // Check the clock before success too: an answer that arrives at or after
      // the deadline is a late answer, not a ready provider.
      if (now() >= deadline) {
        lastDetail = `HTTP ${res.status} answered at or after the ${deadlineMs}ms client-side wait bound`;
        break;
      }
      // A 2xx write is not readiness by itself: confirm the row the write was
      // meant to store carries an `embedding` that is a nonempty array and a
      // nonempty `embeddingModel` stamp. That is all the check establishes; it
      // does not test the vector's values. A row without both is retried
      // within the deadline, then the wait fails closed naming the reason.
      if (opts.confirm) {
        let confirmed;
        try {
          confirmed = await opts.confirm(res, Math.max(1, deadline - now()));
        } catch (err) {
          confirmed = { ready: false, detail: `read-back failed: ${err?.message ?? err}` };
        }
        if (!confirmed?.ready) {
          lastDetail = confirmed?.detail ?? "read-back did not confirm a stored embedding";
          const wait = Math.min(backoffMs, Math.max(0, deadline - now()));
          if (wait > 0) await sleep(wait);
          continue;
        }
        if (now() >= deadline) {
          lastDetail = `HTTP ${res.status} confirmed at or after the ${deadlineMs}ms client-side wait bound`;
          break;
        }
      }
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

/**
 * Record the warm-up duration in the job summary. An unset (or empty)
 * GITHUB_STEP_SUMMARY is a no-op. A set path is appended to, and
 * `appendFileSync` creates the file if it does not exist yet; a set path that
 * cannot be written fails the caller by name.
 */
export function recordStepSummary(label, result) {
  const dest = process.env.GITHUB_STEP_SUMMARY;
  if (!dest) return false;
  try {
    appendFileSync(dest, `- ${label}: embedding model ready in ${result.elapsedMs} ms after ${result.attempts} attempt(s)\n`);
    return true;
  } catch (err) {
    throw new Error(
      `${label}: could not append the embedding-readiness duration to GITHUB_STEP_SUMMARY (${dest}): ${err?.message ?? err}`,
    );
  }
}

/**
 * POST one operations-API request. A 401 to the credentialed request is retried
 * once without `Authorization`. One `AbortSignal.timeout(timeoutMs)` is shared
 * by both requests, so the 401 fallback cannot double an operation's
 * client-side bound. Exported for its tests.
 */
export async function opsPost(opsUrl, authHeader, body, fetchImpl = fetch, timeoutMs = OPS_TIMEOUT_MS) {
  const json = JSON.stringify(body);
  const headers = { "Content-Type": "application/json" };
  if (authHeader) headers.Authorization = authHeader;
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  const send = (withAuth) => fetchImpl(opsUrl, {
    method: "POST",
    headers: withAuth ? headers : { "Content-Type": "application/json" },
    body: json,
    signal,
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

/** Delete the warm-up rows and agent; return one message per failed delete. */
async function deleteWarmResidue(opsUrl, authHeader, agentId, memoryIds, fetchImpl) {
  const failures = [];
  // A failed row delete must not skip the agent delete.
  if (memoryIds.length > 0) {
    try {
      await opsPost(opsUrl, authHeader, {
        operation: "delete", database: "flair", table: "Memory", ids: memoryIds,
      }, fetchImpl);
    } catch (err) {
      failures.push(`Memory [${memoryIds.join(", ")}]: ${err?.message ?? err}`);
    }
  }
  try {
    await opsPost(opsUrl, authHeader, {
      operation: "delete", database: "flair", table: "Agent", ids: [agentId],
    }, fetchImpl);
  } catch (err) {
    failures.push(`Agent [${agentId}]: ${err?.message ?? err}`);
  }
  return failures;
}

/**
 * Wait for one stored embedding on a real instance, through a throwaway agent
 * and memory rows the helper deletes when the wait ends. A 2xx write is not
 * enough: the row is read back and its `embedding` must be a nonempty array
 * with a nonempty `embeddingModel` stamp. A failed delete fails the wait and
 * names the rows and agent that may remain. The wait exercises the server's
 * Memory PUT embedding path, so an embedding was observed on this instance
 * before the lane's next write runs; that is an observation, not a guarantee
 * the model stays loaded.
 *
 * @returns {Promise<{elapsedMs: number, attempts: number}>}
 */
export async function warmInstanceEmbeddings(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const label = opts.label ?? "embedding readiness";
  const agentId = await createWarmAgent(opts.opsUrl, opts.authHeader, fetchImpl);
  const memoryIds = [];
  let pendingMemId;
  let result;
  let readinessError;
  try {
    result = await awaitEmbeddingReady({
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
        pendingMemId = memId;
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
          // `remainingMs` bounds this client's wait, not the provider call: an
          // in-process timeout cannot preempt a provider that never yields
          // (resources/memory-write-lock.ts). A monotonic clock may yield fractional
          // milliseconds; Node's `AbortSignal.timeout` requires an integer.
          signal: AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs))),
        });
      },
      confirm: async (_res, remainingMs) => {
        const memId = pendingMemId;
        let text;
        try {
          text = await opsPost(opts.opsUrl, opts.authHeader, {
            operation: "search_by_id", database: "flair", table: "Memory",
            ids: [memId], get_attributes: ["*"],
          }, fetchImpl, remainingMs);
        } catch (err) {
          return { ready: false, detail: `row ${memId} read-back failed: ${err?.message ?? err}` };
        }
        let rows;
        try {
          rows = JSON.parse(text);
        } catch {
          return { ready: false, detail: `row ${memId} read-back was not JSON: ${text}` };
        }
        const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.id === memId) : undefined;
        if (!row) return { ready: false, detail: `row ${memId} read-back found no stored row` };
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
          return { ready: false, detail: `row ${memId} stored no vector` };
        }
        if (typeof row.embeddingModel !== "string" || row.embeddingModel.length === 0) {
          return { ready: false, detail: `row ${memId} stored no embedding model stamp` };
        }
        return { ready: true };
      },
    });
  } catch (err) {
    readinessError = err;
  }
  const cleanupFailures = await deleteWarmResidue(opts.opsUrl, opts.authHeader, agentId, memoryIds, fetchImpl);
  if (cleanupFailures.length > 0) {
    const message = `${label}: embedding warm-up cleanup failed; these rows may remain: ${cleanupFailures.join("; ")}`;
    if (readinessError) throw new Error(`${readinessError.message}; ${message}`);
    throw new Error(message);
  }
  if (readinessError) throw readinessError;
  return result;
}

function argValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** A URL carrying a username or password is refused, naming only its origin. */
function refuseUrlCredentials(name, raw) {
  const url = new URL(raw);
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      `${name} must not carry a username or password (got ${url.protocol}//${url.host}); ` +
      `set FLAIR_ADMIN_USER / FLAIR_ADMIN_PASS instead`,
    );
  }
  return url;
}

/**
 * Config for the command-line form. Basic-auth credentials come only from
 * FLAIR_ADMIN_USER and FLAIR_ADMIN_PASS, which default to `admin` / `admin123`
 * (the test instances' admin) when unset. There are no credential flags, and a
 * base or ops URL (from --base-url / --ops-url or FLAIR_URL / FLAIR_TEST_URL /
 * FLAIR_OPS_URL) that carries a username or password is refused.
 */
export function warmCliConfig(argv = process.argv.slice(2), env = process.env) {
  const baseUrl = (argValue(argv, "--base-url") ?? env.FLAIR_URL ?? env.FLAIR_TEST_URL ?? "http://127.0.0.1:9926")
    .replace(/\/$/, "");
  const httpPort = Number(refuseUrlCredentials("the base URL (--base-url)", baseUrl).port || 9926);
  const opsUrl = argValue(argv, "--ops-url") ?? env.FLAIR_OPS_URL ?? `http://127.0.0.1:${httpPort - 1}`;
  refuseUrlCredentials("the ops URL (--ops-url)", opsUrl);
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

/**
 * True when this file is the process entry. Both sides are compared as real
 * paths: Node resolves the entry module through symlinks, so comparing the raw
 * argv path made a run through a symlinked directory (macOS /var -> /private/var)
 * skip main() and exit 0 without waiting.
 */
export function isEntryModule(argv1, moduleUrl = import.meta.url) {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

const invokedDirectly = isEntryModule(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
